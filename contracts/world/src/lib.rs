pub mod body;
pub mod events;
pub mod external;
pub mod market;
pub mod market_impl;
pub mod recipes;
pub mod state;
pub mod tick;

use near_sdk::{
    env,
    json_types::U128,
    near,
    store::{IterableMap, LookupMap},
    AccountId,
    Allowance,
    BorshStorageKey,
    Gas,
    NearToken,
    PanicOnDefault,
    Promise,
    PublicKey,
};

use crate::{
    body::{is_dead, spoil_ticks_for, DURABILITY_MAX},
    external::{ext_coin, ext_items},
    market::{is_expired, INITIAL_PRICE_INDEX},
    recipes::ALL_ITEMS,
    state::{
        Action, AgentProfile, BodyState, BuyFill, EconomySnapshot, InventoryLine, ItemQty,
        MirrorView, Order, OrderSide, Perception, PerceptionBody, PerceptionProfile, PriceLine,
        SeedAgent, Season, ToolView, WorldView,
    },
    tick::time_label,
};

/// NEP-145 registration minimum shared with the items and coin contracts.
const STORAGE_DEPOSIT_YOCTO: u128 = 2_500_000_000_000_000_000_000;
/// Origin account-creation funding (0.01 NEAR per sub-account).
const AGENT_CREATION_TRANSFER_YOCTO: u128 = 10_000_000_000_000_000_000_000;
/// 600 Tgas tick / factory budget is an orchestrator attach; these bound each hop.
const GAS_FOR_ITEMS_CALL: Gas = Gas::from_tgas(20);
const GAS_FOR_COIN_CALL: Gas = Gas::from_tgas(20);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// The W2 perception view is capped at 12 lines, like origin.
const ORDER_BOOK_CAP: usize = 12;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Agents,
    Locations,
    BodyState,
    ToolState,
    Feedback,
    SpoilsAt,
    CoinBalanceMirror,
    ItemBalanceMirror,
    Orders,
    PendingFills,
    TradePriceRing,
    PriceIndex,
    PendingActions,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct World {
    owner: AccountId,
    items_contract: AccountId,
    coin_contract: AccountId,
    tick: u64,
    weather: String,
    season: Season,
    day_of_season: u8,
    agents: IterableMap<AccountId, AgentProfile>,
    locations: LookupMap<AccountId, String>,
    body_state: LookupMap<AccountId, BodyState>,
    tool_state: LookupMap<AccountId, u8>,
    feedback: LookupMap<AccountId, Vec<String>>,
    spoils_at: LookupMap<(AccountId, String), u64>,
    coin_balance_mirror: LookupMap<AccountId, u128>,
    item_balance_mirror: LookupMap<AccountId, Vec<ItemQty>>,
    orders: IterableMap<u64, Order>,
    pending_fills: LookupMap<u64, BuyFill>,
    trade_price_ring: LookupMap<String, Vec<u64>>,
    price_index: LookupMap<String, u64>,
    pending_actions: LookupMap<AccountId, Vec<Action>>,
    tax_rate_bps: u16,
    elder: AccountId,
    total_tax_collected: u128,
    last_snapshot: EconomySnapshot,
    trade_volume: [u128; 16],
    next_trade_seq: u64,
    next_order_seq: u64,
    next_fill_seq: u64,
}

#[near]
impl World {
    #[init]
    pub fn new(
        items_contract: AccountId,
        coin_contract: AccountId,
        seed_agents: Vec<SeedAgent>,
    ) -> Self {
        let owner = env::predecessor_account_id();
        let elder = format!("otto.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("cannot derive the elder account id"));

        let mut world = Self {
            owner,
            items_contract,
            coin_contract,
            tick: 1,
            weather: "Mild, 12°C, partly cloudy".to_string(),
            season: Season::Spring,
            day_of_season: 1,
            agents: IterableMap::new(StorageKey::Agents),
            locations: LookupMap::new(StorageKey::Locations),
            body_state: LookupMap::new(StorageKey::BodyState),
            tool_state: LookupMap::new(StorageKey::ToolState),
            feedback: LookupMap::new(StorageKey::Feedback),
            spoils_at: LookupMap::new(StorageKey::SpoilsAt),
            coin_balance_mirror: LookupMap::new(StorageKey::CoinBalanceMirror),
            item_balance_mirror: LookupMap::new(StorageKey::ItemBalanceMirror),
            orders: IterableMap::new(StorageKey::Orders),
            pending_fills: LookupMap::new(StorageKey::PendingFills),
            trade_price_ring: LookupMap::new(StorageKey::TradePriceRing),
            price_index: LookupMap::new(StorageKey::PriceIndex),
            pending_actions: LookupMap::new(StorageKey::PendingActions),
            tax_rate_bps: 1000,
            elder,
            total_tax_collected: 0,
            last_snapshot: EconomySnapshot::genesis(),
            trade_volume: [0; 16],
            next_trade_seq: 0,
            next_order_seq: 0,
            next_fill_seq: 0,
        };

        for (item, price) in INITIAL_PRICE_INDEX {
            world.price_index.insert(item.to_string(), price);
        }

        for seed in seed_agents {
            let account_id: AccountId = format!("{}.{}", seed.name, env::current_account_id())
                .parse()
                .unwrap_or_else(|_| {
                    env::panic_str(&format!("invalid seed agent name: {}", seed.name))
                });

            if world.agents.insert(account_id.clone(), seed.profile.clone()).is_some() {
                env::panic_str(&format!("duplicate seed agent: {}", seed.name));
            }

            world
                .locations
                .insert(account_id.clone(), seed.profile.home.clone());
            world
                .body_state
                .insert(account_id.clone(), BodyState::default());
            world
                .tool_state
                .insert(account_id.clone(), seed.profile.tool_durability);
            world.feedback.insert(account_id.clone(), Vec::new());
            world
                .coin_balance_mirror
                .insert(account_id.clone(), seed.profile.wallet);
            world
                .item_balance_mirror
                .insert(account_id.clone(), Vec::new());
            for (item, quantity) in &seed.profile.inventory {
                world.record_item_receipt(&account_id, item, *quantity);
            }
        }

        world
    }

    /// One deterministic simulation tick. The orchestrator attaches the gas;
    /// only the world owner may drive the clock.
    pub fn run_tick(&mut self) {
        self.assert_owner();
        self.run_tick_phases();
        self.tick = self.tick.saturating_add(1);
        self.next_order_seq = 0;
    }

    /// An NPC queues its next-tick actions. The relayer and FCK both land here.
    pub fn submit_actions(&mut self, actions: Vec<Action>) {
        let agent = env::predecessor_account_id();
        if self.agents.get(&agent).is_none() {
            env::panic_str("submit_actions: predecessor is not a registered agent");
        }
        self.pending_actions.insert(agent, actions);
    }

    /// Create the on-chain sub-account for a seeded NPC, issue its gas-only
    /// function-call key, register it on items+coin, and seed its wallet.
    #[payable]
    pub fn create_agent(&mut self, name: String, public_key: PublicKey) -> Promise {
        self.assert_owner();
        let current = env::current_account_id();
        let agent: AccountId = format!("{name}.{current}")
            .parse()
            .unwrap_or_else(|_| env::panic_str("create_agent: invalid agent name"));
        let profile = self
            .agents
            .get(&agent)
            .cloned()
            .unwrap_or_else(|| env::panic_str("create_agent: name is not a seeded agent"));
        let allowance =
            Allowance::limited(NearToken::from_near(8)).unwrap_or(Allowance::Unlimited);
        let deposit = NearToken::from_yoctonear(STORAGE_DEPOSIT_YOCTO);

        self.coin_balance_mirror.insert(agent.clone(), profile.wallet);

        let mut promise = Promise::new(agent.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(AGENT_CREATION_TRANSFER_YOCTO))
            .add_access_key_allowance(public_key, allowance, current, "submit_actions")
            .then(
                ext_items::ext(self.items_contract.clone())
                    .with_static_gas(GAS_FOR_ITEMS_CALL)
                    .with_attached_deposit(deposit)
                    .storage_deposit(Some(agent.clone()), Some(true)),
            )
            .then(
                ext_coin::ext(self.coin_contract.clone())
                    .with_static_gas(GAS_FOR_COIN_CALL)
                    .with_attached_deposit(deposit)
                    .storage_deposit(Some(agent.clone()), Some(true)),
            )
            .then(
                ext_coin::ext(self.coin_contract.clone())
                    .with_static_gas(GAS_FOR_COIN_CALL)
                    .with_attached_deposit(ONE_YOCTO)
                    .ft_transfer(agent.clone(), U128(profile.wallet), None),
            );

        for (item, quantity) in &profile.inventory {
            promise = promise.then(
                ext_items::ext(self.items_contract.clone())
                    .with_static_gas(GAS_FOR_ITEMS_CALL)
                    .mint(agent.clone(), item.clone(), U128(*quantity), None),
            );
        }

        promise
    }

    /// Register the world itself as an items holder (escrow storage) and a coin
    /// holder (buy settlement). Owner-only, run once after deployment.
    #[payable]
    pub fn register_world(&mut self) -> Promise {
        self.assert_owner();
        let current = env::current_account_id();
        let deposit = NearToken::from_yoctonear(STORAGE_DEPOSIT_YOCTO);

        ext_items::ext(self.items_contract.clone())
            .with_static_gas(GAS_FOR_ITEMS_CALL)
            .with_attached_deposit(deposit)
            .storage_deposit(Some(current.clone()), Some(true))
            .then(
                ext_coin::ext(self.coin_contract.clone())
                    .with_static_gas(GAS_FOR_COIN_CALL)
                    .with_attached_deposit(deposit)
                    .storage_deposit(Some(current), Some(true)),
            )
    }

    /// World-local perception prompt for one agent. No cross-contract reads:
    /// views may not create promises.
    pub fn get_perception(&self, agent_id: AccountId) -> String {
        let profile = match self.agents.get(&agent_id) {
            Some(profile) => profile.clone(),
            None => env::panic_str("get_perception: unknown agent"),
        };
        let body = self.body_state.get(&agent_id).copied().unwrap_or_default();
        let durability = self.tool_state.get(&agent_id).copied().unwrap_or(0);
        let inventory = self
            .item_balance_mirror
            .get(&agent_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|(_, quantity)| *quantity > 0)
            .map(|(item, quantity)| InventoryLine {
                item,
                quantity: U128(quantity),
            })
            .collect();
        let price_index = ALL_ITEMS
            .iter()
            .map(|item| PriceLine {
                item: (*item).to_string(),
                price: U128(
                    self.price_index
                        .get(&(*item).to_string())
                        .copied()
                        .unwrap_or(0) as u128,
                ),
            })
            .collect();
        let perception = Perception {
            tick: self.tick,
            time: time_label(self.tick),
            season: self.season,
            weather: self.weather.clone(),
            location: self.location_of(&agent_id),
            body: PerceptionBody {
                hunger: body.hunger,
                energy: body.energy,
                sleep_quality: body.sleep_quality,
                sickness: body.sickness,
            },
            profile: PerceptionProfile {
                skill: profile.skill.clone(),
                home: profile.home.clone(),
                work: profile.work.clone(),
                work_start: profile.work_start,
                work_end: profile.work_end,
            },
            mirrors: MirrorView {
                wallet: U128(self.mirror_coin(&agent_id)),
                inventory,
            },
            tool: profile.tool.as_ref().map(|item| ToolView {
                item: item.clone(),
                durability,
            }),
            price_index,
            order_book: self.order_book_for(),
            feedback: self.feedback.get(&agent_id).cloned().unwrap_or_default(),
        };

        near_sdk::serde_json::to_string(&perception)
            .unwrap_or_else(|_| env::panic_str("get_perception: serialization failed"))
    }

    /// The 12-line order book: sells cheapest-first, then buys richest-first.
    pub fn get_order_book(&self, agent_id: AccountId) -> Vec<Order> {
        let _ = agent_id;
        self.order_book_for()
    }

    pub fn get_world_view(&self) -> WorldView {
        WorldView {
            tick: self.tick,
            time: time_label(self.tick),
            weather: self.weather.clone(),
            season: self.season,
            day_of_season: self.day_of_season,
            locations: self.sorted_locations(),
            bodies: self.sorted_bodies(),
            last_snapshot: self.last_snapshot.clone(),
        }
    }

    pub fn get_economy_snapshot(&self) -> EconomySnapshot {
        self.last_snapshot.clone()
    }
}

impl World {
    fn assert_owner(&self) {
        if env::predecessor_account_id() != self.owner {
            env::panic_str("only the world owner may call this method");
        }
    }

    fn sorted_locations(&self) -> Vec<(AccountId, String)> {
        let mut locations: Vec<(AccountId, String)> = self
            .agents
            .keys()
            .filter_map(|agent| {
                self.locations
                    .get(agent)
                    .map(|location| (AccountId::clone(agent), location.clone()))
            })
            .collect();
        locations.sort_by(|left, right| left.0.as_str().cmp(right.0.as_str()));
        locations
    }

    fn sorted_bodies(&self) -> Vec<(AccountId, BodyState)> {
        let mut bodies: Vec<(AccountId, BodyState)> = self
            .agents
            .keys()
            .filter_map(|agent| {
                self.body_state
                    .get(agent)
                    .map(|body| (AccountId::clone(agent), *body))
            })
            .collect();
        bodies.sort_by(|left, right| left.0.as_str().cmp(right.0.as_str()));
        bodies
    }

    /// Stable agent order for every phase and event sequence.
    fn sorted_agents(&self) -> Vec<AccountId> {
        let mut agents: Vec<AccountId> = self.agents.keys().cloned().collect();
        agents.sort_by(|left, right| left.as_str().cmp(right.as_str()));
        agents
    }

    fn agent_is_dead(&self, agent: &AccountId) -> bool {
        self.body_state
            .get(agent)
            .map(|body| is_dead(body.starvation_ticks))
            .unwrap_or(false)
    }

    pub(crate) fn location_of(&self, agent: &AccountId) -> String {
        self.locations.get(agent).cloned().unwrap_or_else(|| {
            self.agents
                .get(agent)
                .map(|profile| profile.home.clone())
                .unwrap_or_default()
        })
    }

    pub(crate) fn mirror_coin(&self, agent: &AccountId) -> u128 {
        self.coin_balance_mirror.get(agent).copied().unwrap_or(0)
    }

    pub(crate) fn mirror_item_qty(&self, agent: &AccountId, item: &str) -> u128 {
        self.item_balance_mirror
            .get(agent)
            .and_then(|inventory| {
                inventory
                    .iter()
                    .find(|(name, _)| name.as_str() == item)
                    .map(|(_, quantity)| *quantity)
            })
            .unwrap_or(0)
    }

    /// Credit a mint or a received item and refresh its per-stack spoil timer.
    pub(crate) fn record_item_receipt(&mut self, agent: &AccountId, item: &str, quantity: u128) {
        if quantity == 0 {
            return;
        }
        self.mirror_add_item(agent, item, quantity);
        if let Some(ttl) = spoil_ticks_for(item) {
            self.spoils_at.insert(
                (agent.clone(), item.to_string()),
                self.tick.saturating_add(ttl as u64),
            );
        }
    }

    fn agent_mint_item(&mut self, agent: &AccountId, item: &str, quantity: u128) {
        if quantity == 0 {
            return;
        }
        self.record_item_receipt(agent, item, quantity);
        let _ = ext_items::ext(self.items_contract.clone())
            .with_static_gas(GAS_FOR_ITEMS_CALL)
            .mint(agent.clone(), item.to_string(), U128(quantity), None);
    }

    fn agent_burn_item(&mut self, agent: &AccountId, item: &str, quantity: u128) {
        let amount = quantity.min(self.mirror_item_qty(agent, item));
        if amount == 0 {
            return;
        }
        self.mirror_remove_item(agent, item, amount);
        let _ = ext_items::ext(self.items_contract.clone())
            .with_static_gas(GAS_FOR_ITEMS_CALL)
            .burn(agent.clone(), item.to_string(), U128(amount));
    }

    /// Burn stock held by the world itself (escrowed sells, spoiled lots).
    fn burn_escrowed_item(&mut self, item: &str, quantity: u128) {
        if quantity == 0 {
            return;
        }
        let _ = ext_items::ext(self.items_contract.clone())
            .with_static_gas(GAS_FOR_ITEMS_CALL)
            .burn(
                env::current_account_id(),
                item.to_string(),
                U128(quantity),
            );
    }

    pub(crate) fn equip_tool(&mut self, agent: &AccountId) {
        if let Some(profile) = self.agents.get_mut(agent) {
            profile.tool = Some("iron_tools".to_string());
        }
        self.tool_state.insert(agent.clone(), DURABILITY_MAX);
    }

    pub(crate) fn push_feedback(&mut self, agent: &AccountId, message: impl ToString) {
        let mut feedback = self.feedback.get(agent).cloned().unwrap_or_default();
        feedback.push(message.to_string());
        self.feedback.insert(agent.clone(), feedback);
    }

    fn clear_feedback(&mut self) {
        for agent in self.sorted_agents() {
            self.feedback.insert(agent, Vec::new());
        }
    }

    fn reserved_item_qty(&self, agent: &AccountId, item: &str) -> u128 {
        self.orders
            .values()
            .filter(|order| {
                order.side == OrderSide::Sell
                    && &order.agent_id == agent
                    && order.item.as_str() == item
                    && !is_expired(order.expires_at, self.tick)
            })
            .fold(0u128, |sum, order| sum.saturating_add(order.quantity))
    }

    fn owned_item_qty(&self, agent: &AccountId, item: &str) -> u128 {
        self.mirror_item_qty(agent, item)
            .saturating_add(self.reserved_item_qty(agent, item))
    }

    fn total_item_supply(&self, item: &str) -> u128 {
        self.sorted_agents().iter().fold(0u128, |sum, agent| {
            sum.saturating_add(self.owned_item_qty(agent, item))
        })
    }

    fn order_book_for(&self) -> Vec<Order> {
        let mut orders: Vec<Order> = self
            .orders
            .values()
            .filter(|order| !is_expired(order.expires_at, self.tick))
            .cloned()
            .collect();
        orders.sort_by(|left, right| match (left.side, right.side) {
            (OrderSide::Sell, OrderSide::Sell) => left
                .price
                .cmp(&right.price)
                .then(left.id.cmp(&right.id)),
            (OrderSide::Buy, OrderSide::Buy) => right
                .price
                .cmp(&left.price)
                .then(left.id.cmp(&right.id)),
            (OrderSide::Sell, OrderSide::Buy) => std::cmp::Ordering::Less,
            (OrderSide::Buy, OrderSide::Sell) => std::cmp::Ordering::Greater,
        });
        orders.truncate(ORDER_BOOK_CAP);
        orders
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body::{
        energy_after_work, hunger_after_dawn, hunger_on_hour, is_starved, satiation_for,
        spoil_ticks_for, DURABILITY_LOSS, DURABILITY_MAX, ENERGY_MAX, HUNGER_MAX, SATIATION,
        SPOIL_TICKS, STARVATION_TICKS,
    };
    use crate::market::{
        expires_at, fill_id, initial_price, mean_price, order_id, push_price, trade_volume_slot,
        ORDER_TTL, PRICE_RING_CAP,
    };
    use crate::recipes::{
        apply_multipliers, canonical_item_rank, recipe_for, season_multiplier_bps, ALL_ITEMS,
        RECIPES, SEASON_BPS,
    };
    use crate::tick::{
        day_of_season, day_name, hour_of_day, is_first_tick_of_day, is_week_start, season_for_tick,
        sleep_quality, sleep_roll, time_label, weather_for, DAYS_PER_SEASON, TICKS_PER_DAY,
        TICKS_PER_SEASON,
    };

    #[test]
    fn economy_tables_are_complete_and_canonical() {
        assert_eq!(ALL_ITEMS.len(), 18);
        assert_eq!(RECIPES.len(), 18);
        assert_eq!(SEASON_BPS.len(), 18);
        assert_eq!(canonical_item_rank("wheat"), 0);
        assert_eq!(canonical_item_rank("cloth"), 17);
        assert_eq!(canonical_item_rank("unknown"), usize::MAX);

        for item in ALL_ITEMS {
            assert!(recipe_for(item).is_some(), "missing recipe for {item}");
        }
    }

    #[test]
    fn bread_recipe_is_one_flour_to_four_bread() {
        let bread = recipe_for("bread").expect("bread recipe");
        assert_eq!(bread.output, "bread");
        assert_eq!(bread.base_qty, 4);
        assert_eq!(bread.inputs, &[("flour", 1)]);
        assert_eq!(bread.location, "Bakery");
        assert_eq!(bread.skill, "baker");
        assert!(!bread.needs_tool);
    }

    #[test]
    fn winter_blocks_field_crops_and_herbs() {
        assert_eq!(season_multiplier_bps("wheat", &Season::Winter), 0);
        assert_eq!(season_multiplier_bps("vegetables", &Season::Winter), 0);
        assert_eq!(season_multiplier_bps("herbs", &Season::Winter), 0);
        assert_eq!(season_multiplier_bps("bread", &Season::Winter), 1000);
        assert_eq!(season_multiplier_bps("unknown", &Season::Winter), 1000);
    }

    #[test]
    fn multiplier_math_floors() {
        assert_eq!(apply_multipliers(4, 1200, 1000), 4);
        assert_eq!(apply_multipliers(5, 1200, 1000), 6);
        assert_eq!(apply_multipliers(3, 1500, 1000), 4);
        assert_eq!(apply_multipliers(1, 800, 1000), 0);
        assert_eq!(apply_multipliers(3, 1000, 1000), 3);
    }

    #[test]
    fn price_ring_and_rounding() {
        assert_eq!(mean_price(&[]), None);
        assert_eq!(mean_price(&[5]), Some(5));
        assert_eq!(mean_price(&[4, 5]), Some(5));
        assert_eq!(mean_price(&[1, 2]), Some(2));
        assert_eq!(mean_price(&[3, 4]), Some(4));

        let mut ring = Vec::new();
        for price in 0..12 {
            push_price(&mut ring, price);
        }
        assert_eq!(ring.len(), PRICE_RING_CAP);
        assert_eq!(ring.first(), Some(&2));
        assert_eq!(ring.last(), Some(&11));
        assert_eq!(PRICE_RING_CAP, 10);
        assert_eq!(ORDER_TTL, 16);
    }

    #[test]
    fn deterministic_ids_and_slots() {
        assert_eq!(order_id(1, 2), (1 << 20) | 2);
        assert_eq!(fill_id(3, 4), (3 << 20) | 4);
        assert_eq!(expires_at(5), 21);
        assert_eq!(trade_volume_slot(0), 0);
        assert_eq!(trade_volume_slot(15), 15);
        assert_eq!(trade_volume_slot(16), 0);
    }

    #[test]
    fn sleep_rolls_are_deterministic() {
        for tick in 0..4 {
            for agent_index in 0..3 {
                assert_eq!(sleep_roll(tick, agent_index), agent_index as u8);
            }
        }
        assert_eq!(sleep_roll(16, 0), 19);
        assert_eq!(sleep_roll(16, 2), 21);
        assert_eq!(sleep_roll(31, 0), 19);
        assert_eq!(sleep_roll(32, 1), 39);
        assert_eq!(sleep_quality(0, 0), 90);
        assert_eq!(sleep_quality(49, 0), 90);
        assert_eq!(sleep_quality(50, 0), 70);
        assert_eq!(sleep_quality(84, 0), 70);
        assert_eq!(sleep_quality(85, 0), 50);
        assert_eq!(sleep_quality(0, 2), 40);
    }

    #[test]
    fn calendar_maps_origin_semantics() {
        assert_eq!(TICKS_PER_DAY, 16);
        assert_eq!(DAYS_PER_SEASON, 7);
        assert_eq!(TICKS_PER_SEASON, 112);
        assert_eq!(day_of_season(1), 1);
        assert_eq!(day_of_season(16), 1);
        assert_eq!(day_of_season(17), 2);
        assert_eq!(day_of_season(112), 7);
        assert_eq!(day_of_season(113), 1);
        assert_eq!(hour_of_day(1), 6);
        assert_eq!(hour_of_day(16), 21);
        assert_eq!(hour_of_day(17), 6);
        assert_eq!(day_name(1), "Monday");
        assert_eq!(day_name(17), "Tuesday");
        assert_eq!(time_label(1), "Monday, 06:00");
        assert_eq!(time_label(16), "Monday, 21:00");
        assert_eq!(time_label(17), "Tuesday, 06:00");
        assert!(is_first_tick_of_day(1));
        assert!(is_first_tick_of_day(17));
        assert!(!is_first_tick_of_day(2));
        assert!(is_week_start(1));
        assert!(is_week_start(113));
        assert!(!is_week_start(2));
        assert_eq!(season_for_tick(1), Season::Spring);
        assert_eq!(season_for_tick(112), Season::Spring);
        assert_eq!(season_for_tick(113), Season::Summer);
        assert_eq!(season_for_tick(225), Season::Autumn);
        assert_eq!(season_for_tick(337), Season::Winter);
        assert_eq!(season_for_tick(449), Season::Spring);
        assert_eq!(weather_for(&Season::Spring, 1), "Mild, 12°C, sunny");
        assert_eq!(weather_for(&Season::Winter, 6), "Blizzard, -8°C");
    }

    #[test]
    fn body_constants_match_origin() {
        assert_eq!(HUNGER_MAX, 5);
        assert_eq!(ENERGY_MAX, 100);
        assert_eq!(DURABILITY_MAX, 100);
        assert_eq!(DURABILITY_LOSS, 3);
        assert_eq!(STARVATION_TICKS, 3);
        assert_eq!(SATIATION.len(), 7);
        assert_eq!(satiation_for("bread"), Some(2));
        assert_eq!(satiation_for("meal"), Some(3));
        assert_eq!(satiation_for("ale"), Some(0));
        assert_eq!(satiation_for("wheat"), None);
        assert_eq!(SPOIL_TICKS, [("milk", 32), ("meat", 48)]);
        assert_eq!(spoil_ticks_for("milk"), Some(32));
        assert_eq!(spoil_ticks_for("meat"), Some(48));
        assert_eq!(spoil_ticks_for("bread"), None);
        assert_eq!(hunger_after_dawn(3), 2);
        assert_eq!(hunger_after_dawn(0), 0);
        assert_eq!(hunger_on_hour(2, 4), 3);
        assert_eq!(hunger_on_hour(5, 4), 5);
        assert_eq!(hunger_on_hour(2, 5), 2);
        assert!(is_starved(3));
        assert!(!is_starved(2));
        assert_eq!(energy_after_work(9), 4);
        assert_eq!(energy_after_work(3), 0);
    }

    #[test]
    fn price_index_seed_covers_every_item() {
        for item in ALL_ITEMS {
            assert!(initial_price(item).is_some(), "missing seed price for {item}");
        }
        assert_eq!(initial_price("bread"), Some(3));
        assert_eq!(initial_price("iron_tools"), Some(15));
        assert_eq!(initial_price("unknown"), None);
    }

    #[test]
    fn perception_json_matches_orchestrator_shape() {
        let perception = Perception {
            tick: 7,
            time: "Monday, 12:00".to_string(),
            season: Season::Spring,
            weather: "Mild, 12°C, sunny".to_string(),
            location: "Village Square".to_string(),
            body: PerceptionBody {
                hunger: 2,
                energy: 55,
                sleep_quality: 70,
                sickness: 0,
            },
            profile: PerceptionProfile {
                skill: "farmer".to_string(),
                home: "Cottage 1".to_string(),
                work: "Farm 1".to_string(),
                work_start: 6,
                work_end: 16,
            },
            mirrors: MirrorView {
                wallet: U128(42),
                inventory: vec![InventoryLine {
                    item: "wheat".to_string(),
                    quantity: U128(3),
                }],
            },
            tool: None,
            price_index: vec![PriceLine {
                item: "wheat".to_string(),
                price: U128(2),
            }],
            order_book: vec![Order {
                id: 1 << 20,
                agent_id: "hans.world.eidolon.testnet".parse().expect("agent id"),
                side: OrderSide::Sell,
                item: "wheat".to_string(),
                quantity: 4,
                price: 2,
                posted_tick: 1,
                expires_at: 17,
            }],
            feedback: vec!["ok".to_string()],
        };

        let value = near_sdk::serde_json::to_value(&perception).expect("perception json");
        assert_eq!(value["season"], "spring");
        assert_eq!(value["mirrors"]["wallet"], "42");
        assert_eq!(value["mirrors"]["inventory"][0]["quantity"], "3");
        assert_eq!(value["tool"], near_sdk::serde_json::Value::Null);
        assert_eq!(value["order_book"][0]["side"], "sell");
        assert_eq!(value["order_book"][0]["quantity"], 4);
        assert_eq!(value["price_index"][0]["price"], "2");
    }
}
