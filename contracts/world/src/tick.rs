use std::collections::BTreeSet;

use near_sdk::{json_types::U128, AccountId};

use crate::{
    body::{
        energy_after_noon, hunger_after_dawn, hunger_after_eating, hunger_on_hour, inedible_hint,
        is_dead, is_starved, satiation_for, sickness_after_dawn, sickness_after_winter,
        sleep_energy, DEAD_STARVATION, DURABILITY_LOSS, HUNGER_MAX, SPOIL_TICKS,
    },
    events::Event,
    market::trade_volume_slot,
    recipes::{
        production_quantity, recipe_for, season_multiplier_bps, valid_production_location, ALL_ITEMS,
    },
    state::{Action, ActionType, EconomySnapshot, OrderSide, Season, WealthEntry},
    World,
};

pub const TICKS_PER_DAY: u64 = 16;
pub const DAYS_PER_SEASON: u64 = 7;
pub const TICKS_PER_SEASON: u64 = TICKS_PER_DAY * DAYS_PER_SEASON;

const DAY_NAMES: [&str; 7] = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];

const WEATHER_TABLE: [[&str; 7]; 4] = [
    [
        "Mild, 12°C, sunny",
        "Overcast, 10°C",
        "Light rain, 9°C",
        "Sunny, 14°C",
        "Windy, 11°C",
        "Clear, 13°C",
        "Cloudy, 10°C",
    ],
    [
        "Hot, 24°C, sunny",
        "Warm, 22°C",
        "Humid, 20°C",
        "Thunder, 18°C",
        "Sunny, 25°C",
        "Hazy, 21°C",
        "Clear, 23°C",
    ],
    [
        "Cool, 8°C, foggy",
        "Windy, 7°C",
        "Rain, 6°C",
        "Overcast, 9°C",
        "Clear, 10°C",
        "Cold, 5°C",
        "Drizzle, 7°C",
    ],
    [
        "Freezing, -2°C",
        "Snow, -4°C",
        "Bitter cold, -6°C",
        "Overcast, 0°C",
        "Ice, -3°C",
        "Blizzard, -8°C",
        "Grey, -1°C",
    ],
];

/// Deterministic replacement for the origin random sleep roll.
pub fn sleep_roll(tick: u64, agent_index: usize) -> u8 {
    (((tick / TICKS_PER_DAY) * 19 + agent_index as u64) % 100) as u8
}

/// Sleep quality is stored as energy tenths at dawn: 90, 70, 50, or 40.
pub fn sleep_quality(roll: u8, sickness: u8) -> u8 {
    if sickness >= 2 {
        40
    } else if roll < 50 {
        90
    } else if roll < 85 {
        70
    } else {
        50
    }
}

pub fn season_for_tick(tick: u64) -> Season {
    let season_index = ((tick.saturating_sub(1)) / TICKS_PER_SEASON) % 4;
    match season_index {
        0 => Season::Spring,
        1 => Season::Summer,
        2 => Season::Autumn,
        _ => Season::Winter,
    }
}

pub fn day_of_season(tick: u64) -> u8 {
    ((((tick.saturating_sub(1)) / TICKS_PER_DAY) % DAYS_PER_SEASON) + 1) as u8
}

/// Sim hour, 06:00 through 21:00 inclusive.
pub fn hour_of_day(tick: u64) -> u8 {
    (6 + ((tick.saturating_sub(1)) % TICKS_PER_DAY)) as u8
}

pub fn day_name(tick: u64) -> &'static str {
    let day_index = ((tick.saturating_sub(1)) / TICKS_PER_DAY) % 7;
    DAY_NAMES[day_index as usize]
}

pub fn time_label(tick: u64) -> String {
    format!("{}, {:02}:00", day_name(tick), hour_of_day(tick))
}

pub fn is_first_tick_of_day(tick: u64) -> bool {
    (tick.saturating_sub(1)) % TICKS_PER_DAY == 0
}

/// Monday's first tick; the weekly tax runs inside this tick's dawn block.
pub fn is_week_start(tick: u64) -> bool {
    tick >= 1 && (tick - 1) % TICKS_PER_SEASON == 0
}

pub fn weather_for(season: &Season, day_of_season: u8) -> &'static str {
    let season_index = match season {
        Season::Spring => 0,
        Season::Summer => 1,
        Season::Autumn => 2,
        Season::Winter => 3,
    };
    let day_index = (day_of_season.saturating_sub(1) % 7) as usize;
    WEATHER_TABLE[season_index][day_index]
}

/// Origin Monday tax: floor(wallet x bps / 10_000).
pub fn tax_for(wallet: u128, bps: u16) -> u128 {
    wallet.saturating_mul(bps as u128) / 10_000
}

/// Origin `OPENING_HOURS`: hour index within the day (0 = 06:00, 15 = 21:00).
/// A location absent from this table is always open.
pub fn opening_hours(location: &str) -> Option<(u8, u8)> {
    match location {
        "Tavern" => Some((4, 15)),
        "Bakery" => Some((0, 8)),
        "Forge" | "Carpenter Shop" | "Mill" => Some((1, 10)),
        "Healer's Hut" => Some((1, 11)),
        _ => None,
    }
}

/// Origin Gini coefficient rounded to basis points.
pub fn gini_bps(wallets: &[u128]) -> u32 {
    if wallets.is_empty() {
        return 0;
    }
    let total: u128 = wallets.iter().copied().sum();
    if total == 0 {
        return 0;
    }
    let mut sorted = wallets.to_vec();
    sorted.sort_unstable();
    let n = sorted.len() as i128;
    let mut weighted: i128 = 0;
    for (index, wallet) in sorted.iter().enumerate() {
        let rank = 2 * (index as i128 + 1) - n - 1;
        weighted += rank * i128::try_from(*wallet).unwrap_or(i128::MAX);
    }
    if weighted <= 0 {
        return 0;
    }
    let numerator = (weighted as u128).saturating_mul(10_000);
    let denominator = (n as u128).saturating_mul(total);
    if denominator == 0 {
        return 0;
    }
    u32::try_from((numerator + denominator / 2) / denominator).unwrap_or(u32::MAX)
}

pub fn sum_trade_volume(ring: &[u128; TICKS_PER_DAY as usize]) -> u128 {
    ring.iter().fold(0u128, |sum, value| sum.saturating_add(*value))
}

impl World {
    /// One deterministic simulation tick. `World::run_tick` asserts the caller
    /// and increments `self.tick` after this returns.
    pub(crate) fn run_tick_phases(&mut self) {
        let tick = self.tick;
        // The volume ring is zeroed once per tick; trades settle into it after.
        self.trade_volume[trade_volume_slot(tick)] = 0;
        Event::TickStarted {
            tick,
            time: time_label(tick),
            season: self.season,
            weather: self.weather.clone(),
        }
        .emit();

        // Feedback describes the previous tick's resolution; clear it before
        // this tick generates new feedback.
        self.clear_feedback();

        self.enforce_opening_hours(tick);
        if is_first_tick_of_day(tick) {
            self.dawn_phase(tick);
        }
        self.body_phase(tick);
        self.actions_phase(tick);
        self.starvation_phase();
        self.prune_expired_orders();
        if is_first_tick_of_day(tick) {
            self.snapshot_phase(tick);
        }
    }

    fn dawn_phase(&mut self, tick: u64) {
        self.season = season_for_tick(tick);
        self.day_of_season = day_of_season(tick);
        self.weather = weather_for(&self.season, self.day_of_season).to_string();

        self.apply_winter_heating();
        self.apply_dawn_auto_eat();
        self.degrade_tools();
        self.auto_equip_tools();
        self.check_spoilage(tick);
        if is_week_start(tick) {
            self.collect_tax();
        }
    }

    /// Origin `enforceOpeningHours`: a closed location sends the agent home.
    /// Laws that modify hours are deferred; the base table is origin-exact.
    fn enforce_opening_hours(&mut self, tick: u64) {
        let hour_index = hour_of_day(tick).saturating_sub(6);
        for agent in self.sorted_agents() {
            let location = self.location_of(&agent);
            let bare = location.rsplit(':').next().unwrap_or(location.as_str());
            let Some((open, close)) = opening_hours(bare) else {
                continue;
            };
            if hour_index < open || hour_index >= close {
                let home = self
                    .agents
                    .get(&agent)
                    .map(|profile| profile.home.clone())
                    .unwrap_or_default();
                if !home.is_empty() && home != location {
                    self.locations.insert(agent, home);
                }
            }
        }
    }

    fn apply_winter_heating(&mut self) {
        if self.season != Season::Winter {
            return;
        }
        for agent in self.sorted_agents() {
            if self.agent_is_dead(&agent) {
                continue;
            }
            if self.mirror_item_qty(&agent, "firewood") > 0 {
                self.agent_burn_item(&agent, "firewood", 1);
                continue;
            }
            let mut body = self.body_state.get(&agent).copied().unwrap_or_default();
            body.energy = crate::body::energy_after_winter(body.energy);
            body.sickness = sickness_after_winter(body.sickness);
            self.body_state.insert(agent.clone(), body);
            self.push_feedback(
                &agent,
                "You had no firewood last night. You feel cold and unwell.",
            );
        }
    }

    fn apply_dawn_auto_eat(&mut self) {
        for agent in self.sorted_agents() {
            if self.agent_is_dead(&agent) {
                continue;
            }
            let mut body = self.body_state.get(&agent).copied().unwrap_or_default();
            if body.hunger < 4 {
                continue;
            }
            let mut choice: Option<(&'static str, u64)> = None;
            for item in ALL_ITEMS {
                let Some(satiation) = satiation_for(item) else {
                    continue;
                };
                if satiation == 0 || self.mirror_item_qty(&agent, item) == 0 {
                    continue;
                }
                let price = self
                    .price_index
                    .get(&item.to_string())
                    .copied()
                    .unwrap_or(u64::MAX);
                // Strict `<` keeps ALL_ITEMS order as the deterministic tie-break.
                if choice.map_or(true, |(_, best)| price < best) {
                    choice = Some((item, price));
                }
            }
            let Some((item, _)) = choice else {
                continue;
            };
            self.agent_burn_item(&agent, item, 1);
            body.hunger = hunger_after_eating(body.hunger, satiation_for(item).unwrap_or(0), 1);
            self.body_state.insert(agent, body);
        }
    }

    fn degrade_tools(&mut self) {
        for agent in self.sorted_agents() {
            let durability = self.tool_state.get(&agent).copied().unwrap_or(0);
            let Some(profile) = self.agents.get(&agent) else {
                continue;
            };
            if profile.tool.is_none() || durability > 0 {
                continue;
            }
            if let Some(profile) = self.agents.get_mut(&agent) {
                profile.tool = None;
            }
            self.tool_state.insert(agent.clone(), 0);
            self.push_feedback(
                &agent,
                "Your iron tools broke. You need new ones to work efficiently.",
            );
        }
    }

    fn auto_equip_tools(&mut self) {
        for agent in self.sorted_agents() {
            if self.agent_is_dead(&agent) {
                continue;
            }
            let durability = self.tool_state.get(&agent).copied().unwrap_or(0);
            let has_tool = self
                .agents
                .get(&agent)
                .map(|profile| profile.tool.is_some())
                .unwrap_or(false);
            if has_tool && durability > 0 {
                continue;
            }
            if self.mirror_item_qty(&agent, "iron_tools") == 0 {
                continue;
            }
            self.agent_burn_item(&agent, "iron_tools", 1);
            self.equip_tool(&agent);
            self.push_feedback(
                &agent,
                "You equipped a fresh set of iron tools from your stock.",
            );
        }
    }

    fn check_spoilage(&mut self, tick: u64) {
        for agent in self.sorted_agents() {
            for (item, _ttl) in SPOIL_TICKS {
                let key = (agent.clone(), item.to_string());
                let Some(spoils_at) = self.spoils_at.get(&key).copied() else {
                    continue;
                };
                if tick <= spoils_at {
                    continue;
                }

                let free = self.mirror_item_qty(&agent, item);
                let mut cancelled: Vec<crate::state::Order> = Vec::new();
                let mut deferred = false;
                for order in self.orders.values() {
                    if order.side == OrderSide::Sell
                        && order.agent_id == agent
                        && order.item.as_str() == item
                    {
                        if order.pending_fills > 0 {
                            deferred = true;
                        } else {
                            cancelled.push(order.clone());
                        }
                    }
                }
                let escrowed: u128 = cancelled
                    .iter()
                    .fold(0u128, |sum, order| sum.saturating_add(order.quantity));
                let total = free.saturating_add(escrowed);
                let had_orders = !cancelled.is_empty();

                if free > 0 {
                    self.agent_burn_item(&agent, item, free);
                }
                for order in cancelled {
                    if order.quantity > 0 {
                        self.burn_escrowed_item(item, order.quantity);
                    }
                    self.orders.remove(&order.id);
                    Event::OrderCancelled {
                        order_id: order.id,
                        agent_id: order.agent_id.clone(),
                        order_type: "sell".to_string(),
                        item: order.item.clone(),
                        quantity: U128(order.quantity),
                        price: U128(order.price),
                    }
                    .emit();
                }
                if !deferred {
                    self.spoils_at.remove(&key);
                }

                if total > 0 {
                    self.push_feedback(
                        &agent,
                        format!("Your {total} {item} spoiled overnight."),
                    );
                }
                if had_orders {
                    self.push_feedback(
                        &agent,
                        format!("Your sell order for {item} was cancelled (spoiled)."),
                    );
                }
            }
        }
    }

    fn collect_tax(&mut self) {
        let elder = self.elder.clone();
        let bps = self.tax_rate_bps;
        for agent in self.sorted_agents() {
            if agent == elder {
                continue;
            }
            let wallet = self.mirror_coin(&agent);
            let tax = tax_for(wallet, bps);
            if tax == 0 {
                continue;
            }
            self.mirror_remove_coin(&agent, tax);
            self.mirror_add_coin(&elder, tax);
            let _ = crate::external::ext_coin::ext(self.coin_contract.clone())
                .with_static_gas(near_sdk::Gas::from_tgas(10))
                .tax(agent.clone(), elder.clone(), U128(tax));
            self.total_tax_collected = self.total_tax_collected.saturating_add(tax);
        }
    }

    fn body_phase(&mut self, tick: u64) {
        let hour = hour_of_day(tick);
        let dawn = is_first_tick_of_day(tick);
        for (index, agent) in self.sorted_agents().into_iter().enumerate() {
            if self.agent_is_dead(&agent) {
                continue;
            }
            let mut body = self.body_state.get(&agent).copied().unwrap_or_default();
            body.hunger = hunger_on_hour(body.hunger, hour);
            if hour >= 14 {
                body.energy = energy_after_noon(body.energy);
            }
            if dawn {
                body.sickness = sickness_after_dawn(body.sickness);
                let roll = sleep_roll(tick, index);
                let quality = sleep_quality(roll, body.sickness);
                body.sleep_quality = quality;
                body.energy = sleep_energy(quality);
                body.hunger = hunger_after_dawn(body.hunger);
            }
            self.body_state.insert(agent, body);
        }
    }

    fn actions_phase(&mut self, tick: u64) {
        let agents = self.sorted_agents();
        let mut produce_requests: Vec<(AccountId, String, String)> = Vec::new();

        for agent in agents {
            let actions = self.pending_actions.remove(&agent).unwrap_or_default();
            if self.agent_is_dead(&agent) {
                continue;
            }
            let mut moved = false;
            for action in actions {
                match action.action_type {
                    ActionType::MoveTo => {
                        let target = action.location.clone().unwrap_or_default();
                        let result = if target.is_empty() {
                            "[Can't move] No location specified.".to_string()
                        } else if moved {
                            "[Can't move] Already moved this hour.".to_string()
                        } else {
                            moved = true;
                            self.locations.insert(agent.clone(), target.clone());
                            format!("Moved to {target}.")
                        };
                        if result.starts_with('[') {
                            self.push_feedback(&agent, &result);
                        }
                        Event::ActionResolved {
                            agent: agent.clone(),
                            action_type: "move_to".to_string(),
                            text: action.text.clone(),
                            result,
                            location: self.location_of(&agent),
                        }
                        .emit();
                    }
                    ActionType::Speak => {
                        let result = match action.text.as_deref() {
                            Some(text) if !text.is_empty() => {
                                format!("{agent} says: \"{text}\"")
                            }
                            _ => "[Can't speak] No text.".to_string(),
                        };
                        if result.starts_with('[') {
                            self.push_feedback(&agent, &result);
                        }
                        Event::ActionResolved {
                            agent: agent.clone(),
                            action_type: "speak".to_string(),
                            text: action.text.clone(),
                            result,
                            location: self.location_of(&agent),
                        }
                        .emit();
                    }
                    ActionType::Eat => {
                        let result = self.resolve_eat_action(&agent, &action);
                        Event::ActionResolved {
                            agent: agent.clone(),
                            action_type: "eat".to_string(),
                            text: action.text.clone(),
                            result,
                            location: self.location_of(&agent),
                        }
                        .emit();
                    }
                    ActionType::Produce => {
                        let item = action.item.clone().unwrap_or_default();
                        let location = self.location_of(&agent);
                        let result = if item.is_empty() {
                            let message = "[Can't produce] No item specified.".to_string();
                            self.push_feedback(&agent, &message);
                            message
                        } else {
                            format!("Started work on {item}.")
                        };
                        Event::ActionResolved {
                            agent: agent.clone(),
                            action_type: "produce".to_string(),
                            text: action.text.clone(),
                            result,
                            location: self.location_of(&agent),
                        }
                        .emit();
                        if !item.is_empty() {
                            produce_requests.push((agent.clone(), item, location));
                        }
                    }
                }
            }
        }

        self.resolve_production_phase(tick, produce_requests);
    }

    fn resolve_eat_action(&mut self, agent: &AccountId, action: &Action) -> String {
        let item = action.item.clone().unwrap_or_default();
        if item.is_empty() {
            let message = "[Can't eat] No item specified.".to_string();
            self.push_feedback(agent, &message);
            return message;
        }
        let quantity = action.quantity.map(|value| value.0).unwrap_or(1);
        if quantity == 0 {
            let message = "[Can't eat] Quantity must be at least 1.".to_string();
            self.push_feedback(agent, &message);
            return message;
        }
        let Some(satiation) = satiation_for(&item) else {
            let message = match inedible_hint(&item) {
                Some(hint) => format!("[Can't eat] {hint}"),
                None => format!("[Can't eat] {item} is not edible."),
            };
            self.push_feedback(agent, &message);
            return message;
        };

        let available = self.mirror_item_qty(agent, &item);
        if available < quantity {
            let reserved = self.reserved_item_qty(agent, &item);
            let message = if reserved > 0 && available.saturating_add(reserved) >= quantity {
                format!(
                    "[Can't eat] Your {item} is reserved in a sell order ({reserved} reserved, {available} free). Cancel the order first with cancel_order, then eat."
                )
            } else {
                format!("[Can't eat] You only have {available} {item}.")
            };
            self.push_feedback(agent, &message);
            return message;
        }

        self.agent_burn_item(agent, &item, quantity);
        let mut body = self.body_state.get(agent).copied().unwrap_or_default();
        body.hunger = hunger_after_eating(body.hunger, satiation, quantity);
        self.body_state.insert(agent.clone(), body);

        let hunger = body.hunger;
        let description = if hunger == 0 {
            "full"
        } else if hunger <= 1 {
            "satisfied"
        } else if hunger <= 2 {
            "peckish"
        } else if hunger <= 3 {
            "hungry"
        } else {
            "very hungry"
        };
        let message = format!("You ate {quantity} {item}. Hunger: {hunger}/5 — {description}.");
        self.push_feedback(agent, &message);
        message
    }

    fn resolve_production_phase(
        &mut self,
        tick: u64,
        requests: Vec<(AccountId, String, String)>,
    ) {
        let mut produced = BTreeSet::new();
        for (agent, item, location) in requests {
            if produced.contains(&agent) {
                self.push_feedback(
                    &agent,
                    "[Can't produce] Already produced this tick. One production per hour.",
                );
                continue;
            }
            match self.resolve_production(&agent, &item, &location, tick) {
                Ok(_) => {
                    produced.insert(agent);
                }
                Err(message) => self.push_feedback(&agent, &message),
            }
        }
    }

    fn resolve_production(
        &mut self,
        agent: &AccountId,
        item: &str,
        location: &str,
        tick: u64,
    ) -> Result<u128, String> {
        let Some(recipe) = recipe_for(item) else {
            return Err(format!("[Can't do that] No recipe for \"{item}\"."));
        };

        let skill = self
            .agents
            .get(agent)
            .map(|profile| profile.skill.clone())
            .unwrap_or_default();
        if skill != recipe.skill {
            return Err(format!(
                "[Can't do that] You don't have the {} skill.",
                recipe.skill
            ));
        }

        if !valid_production_location(item, recipe.location, location) {
            return Err(format!(
                "[Can't do that] You must be at {} to produce {item}.",
                recipe.location
            ));
        }

        let tool = self.agents.get(agent).and_then(|profile| profile.tool.clone());
        let durability = self.tool_state.get(agent).copied().unwrap_or(0);
        if recipe.needs_tool && (tool.is_none() || durability == 0) {
            return Err(format!(
                "[Can't do that] You need working iron tools to produce {item}."
            ));
        }

        for (input, quantity) in recipe.inputs {
            let have = self.mirror_item_qty(agent, input);
            if have < *quantity {
                return Err(format!(
                    "[Can't do that] Need {quantity} {input} but only have {have}."
                ));
            }
        }

        for (input, quantity) in recipe.inputs {
            self.agent_burn_item(agent, input, *quantity);
        }
        if recipe.needs_tool {
            self.tool_state
                .insert(agent.clone(), durability.saturating_sub(DURABILITY_LOSS));
        }

        let season_bps = season_multiplier_bps(item, &self.season);
        if season_bps == 0 {
            for (input, quantity) in recipe.inputs {
                self.agent_mint_item(agent, input, *quantity);
            }
            return Err(format!(
                "[Can't do that] You can't produce {item} in {}.",
                self.season.as_str()
            ));
        }

        let quantity = production_quantity(item, &self.season).unwrap_or(0);
        if quantity == 0 {
            for (input, input_quantity) in recipe.inputs {
                self.agent_mint_item(agent, input, *input_quantity);
            }
            return Err(format!(
                "[Can't do that] You can't produce {item} right now."
            ));
        }

        self.agent_mint_item(agent, item, quantity);
        Event::ProductionCompleted {
            tick,
            agent: agent.clone(),
            item: item.to_string(),
            qty: U128(quantity),
        }
        .emit();
        self.push_feedback(agent, format!("Produced {quantity} {item}."));
        Ok(quantity)
    }

    fn starvation_phase(&mut self) {
        for agent in self.sorted_agents() {
            let mut body = self.body_state.get(&agent).copied().unwrap_or_default();
            if is_dead(body.starvation_ticks) {
                continue;
            }
            if body.hunger < HUNGER_MAX {
                body.starvation_ticks = 0;
            } else {
                body.starvation_ticks = body.starvation_ticks.saturating_add(1);
                if is_starved(body.starvation_ticks) {
                    body.starvation_ticks = DEAD_STARVATION;
                    self.push_feedback(&agent, "You have starved to death.");
                }
            }
            self.body_state.insert(agent, body);
        }
    }

    fn snapshot_phase(&mut self, tick: u64) {
        let agents = self.sorted_agents();
        let wallets: Vec<u128> = agents.iter().map(|agent| self.mirror_coin(agent)).collect();
        let total_wealth = wallets.iter().fold(0u128, |sum, value| sum.saturating_add(*value));
        let gini = gini_bps(&wallets);
        let gdp = sum_trade_volume(&self.trade_volume);

        let mut price_index = Vec::with_capacity(ALL_ITEMS.len());
        for item in ALL_ITEMS {
            let price = self
                .price_index
                .get(&item.to_string())
                .copied()
                .unwrap_or(0);
            price_index.push((item.to_string(), U128(price as u128)));
        }

        let mut scarcity_alerts = Vec::new();
        for item in ["bread", "meat", "milk", "medicine"] {
            if self.total_item_supply(item) < 5 {
                scarcity_alerts.push(item.to_string());
            }
        }

        let mut wealth = Vec::with_capacity(agents.len());
        for agent in &agents {
            let mut inventory_value = 0u128;
            for item in ALL_ITEMS {
                let quantity = self.owned_item_qty(agent, item);
                let price = self
                    .price_index
                    .get(&item.to_string())
                    .copied()
                    .unwrap_or(0);
                inventory_value =
                    inventory_value.saturating_add(quantity.saturating_mul(price as u128));
            }
            wealth.push(WealthEntry {
                agent: agent.clone(),
                wallet: U128(self.mirror_coin(agent)),
                inventory_value: U128(inventory_value),
            });
        }

        let snapshot = EconomySnapshot {
            tick,
            day: self.day_of_season,
            season: self.season,
            total_wealth: U128(total_wealth),
            gini_bps: gini,
            gdp: U128(gdp),
            price_index: price_index.clone(),
            scarcity_alerts: scarcity_alerts.clone(),
            wealth: wealth.clone(),
        };
        self.last_snapshot = snapshot.clone();

        Event::DawnSnapshotTaken {
            tick: snapshot.tick,
            day: snapshot.day,
            season: snapshot.season,
            total_wealth: snapshot.total_wealth,
            gini_bps: snapshot.gini_bps,
            gdp: snapshot.gdp,
            price_index: snapshot.price_index,
            scarcity_alerts: snapshot.scarcity_alerts,
            wealth: snapshot.wealth,
        }
        .emit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tax_is_floored_and_uses_basis_points() {
        assert_eq!(tax_for(0, 1000), 0);
        assert_eq!(tax_for(9, 1000), 0);
        assert_eq!(tax_for(10, 1000), 1);
        assert_eq!(tax_for(99, 1000), 9);
        assert_eq!(tax_for(100, 1000), 10);
        assert_eq!(tax_for(100, 0), 0);
        assert_eq!(tax_for(100, 10_000), 100);
    }

    #[test]
    fn gini_matches_origin_rounding() {
        assert_eq!(gini_bps(&[]), 0);
        assert_eq!(gini_bps(&[0, 0]), 0);
        assert_eq!(gini_bps(&[10, 10]), 0);
        // Gini 0.5 -> 5000 bps.
        assert_eq!(gini_bps(&[0, 10]), 5_000);
        assert_eq!(gini_bps(&[10, 0]), 5_000);
        assert_eq!(gini_bps(&[10, 20]), 1_667);
    }

    #[test]
    fn gdp_sums_the_volume_ring() {
        let mut ring = [0u128; 16];
        ring[0] = 7;
        ring[15] = 11;
        assert_eq!(sum_trade_volume(&ring), 18);
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
    fn opening_hours_match_origin_table() {
        assert_eq!(opening_hours("Bakery"), Some((0, 8)));
        assert_eq!(opening_hours("Tavern"), Some((4, 15)));
        assert_eq!(opening_hours("Mill"), Some((1, 10)));
        assert_eq!(opening_hours("Carpenter Shop"), Some((1, 10)));
        assert_eq!(opening_hours("Healer's Hut"), Some((1, 11)));
        assert_eq!(opening_hours("Village Square"), None);
        assert_eq!(opening_hours("Cottage 1"), None);
    }
}
