pub mod body;
pub mod events;
pub mod external;
pub mod market;
pub mod recipes;
pub mod state;
pub mod tick;

use near_sdk::{
    env,
    near,
    store::{IterableMap, LookupMap},
    AccountId,
    BorshStorageKey,
    PanicOnDefault,
};

use crate::{
    market::INITIAL_PRICE_INDEX,
    state::{
        Action, AgentProfile, BodyState, BuyFill, EconomySnapshot, ItemQty, Order, SeedAgent,
        Season, WorldView,
    },
    tick::time_label,
};

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
            world.coin_balance_mirror.insert(account_id.clone(), 0);
            world
                .item_balance_mirror
                .insert(account_id, Vec::new());
        }

        world
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
}
