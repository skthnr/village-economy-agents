pub const HUNGER_MAX: u8 = 5;
pub const ENERGY_MAX: u8 = 100;
pub const DURABILITY_MAX: u8 = 100;
pub const DURABILITY_LOSS: u8 = 3;
pub const STARVATION_TICKS: u8 = 3;

/// Permanent starvation marker stored in `BodyState.starvation_ticks`.
pub const DEAD_STARVATION: u8 = u8::MAX;

/// One origin energy point is stored as ten tenths. Origin winter heating
/// subtracts 1.0 energy, i.e. ten tenths.
pub const WINTER_ENERGY_PENALTY_TENTHS: u8 = 10;

/// Origin sleep quality values, stored in energy tenths (good/fair/poor/sick).
pub const SLEEP_GOOD: u8 = 90;
pub const SLEEP_FAIR: u8 = 70;
pub const SLEEP_POOR: u8 = 50;
pub const SLEEP_SICK: u8 = 40;

/// Origin satiation table; ale is a drink and does not reduce hunger.
pub const SATIATION: [(&str, u8); 7] = [
    ("bread", 2),
    ("meal", 3),
    ("meat", 2),
    ("vegetables", 1),
    ("eggs", 1),
    ("milk", 1),
    ("ale", 0),
];

/// Whole-stack spoil timers, in ticks after the stack is refreshed.
pub const SPOIL_TICKS: [(&str, u32); 2] = [("milk", 32), ("meat", 48)];

pub fn satiation_for(item: &str) -> Option<u8> {
    SATIATION
        .iter()
        .find(|(known, _)| *known == item)
        .map(|(_, value)| *value)
}

pub fn spoil_ticks_for(item: &str) -> Option<u32> {
    SPOIL_TICKS
        .iter()
        .find(|(known, _)| *known == item)
        .map(|(_, value)| *value)
}

/// Origin `resolveEat` processing hints: an inedible item that still has a use.
pub fn inedible_hint(item: &str) -> Option<&'static str> {
    match item {
        "wheat" => Some(
            "Wheat must be milled into flour (at the Mill) then baked into bread (at the Bakery). Buy bread instead.",
        ),
        "flour" => {
            Some("Flour must be baked into bread (at the Bakery) before it can be eaten. Buy bread instead.")
        }
        "iron_ore" => Some("Iron ore is not food."),
        "coal" => Some("Coal is not food."),
        "timber" => Some("Timber is not food."),
        "firewood" => Some("Firewood is not food."),
        "iron_tools" => Some("Tools are not food."),
        "cloth" => Some("Cloth is not food."),
        "furniture" => Some("Furniture is not food."),
        "herbs" => Some("Herbs are not directly edible — they must be processed into medicine."),
        _ => None,
    }
}

pub fn hunger_after_dawn(hunger: u8) -> u8 {
    hunger.saturating_sub(1)
}

pub fn hunger_on_hour(hunger: u8, hour: u8) -> u8 {
    if hour % 4 == 0 {
        (hunger + 1).min(HUNGER_MAX)
    } else {
        hunger
    }
}

pub fn hunger_after_eating(hunger: u8, satiation: u8, quantity: u128) -> u8 {
    let reduction = (satiation as u128).saturating_mul(quantity);
    let reduction = u8::try_from(reduction).unwrap_or(u8::MAX);
    hunger.saturating_sub(reduction)
}

pub fn is_starved(streak: u8) -> bool {
    streak >= STARVATION_TICKS
}

pub fn is_dead(streak: u8) -> bool {
    streak >= DEAD_STARVATION
}

/// Origin energy loss: −0.5 per hour from 14:00 onwards, stored as tenths.
pub fn energy_after_noon(energy: u8) -> u8 {
    energy.saturating_sub(5)
}

/// Origin winter heating without firewood: −1.0 energy, +1 sickness capped at 3.
pub fn energy_after_winter(energy: u8) -> u8 {
    energy.saturating_sub(WINTER_ENERGY_PENALTY_TENTHS)
}

pub fn sickness_after_winter(sickness: u8) -> u8 {
    (sickness + 1).min(3)
}

/// Origin body update at dawn: heal one sickness point, then set sleep quality
/// and energy from the deterministic roll.
pub fn sickness_after_dawn(sickness: u8) -> u8 {
    sickness.saturating_sub(1)
}

pub fn sleep_energy(sleep_quality: u8) -> u8 {
    match sleep_quality {
        SLEEP_SICK => SLEEP_SICK,
        SLEEP_POOR => SLEEP_POOR,
        SLEEP_FAIR => SLEEP_FAIR,
        _ => SLEEP_GOOD,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winter_penalty_matches_origin_units() {
        assert_eq!(energy_after_winter(90), 80);
        assert_eq!(energy_after_winter(5), 0);
        assert_eq!(sickness_after_winter(0), 1);
        assert_eq!(sickness_after_winter(2), 3);
        assert_eq!(sickness_after_winter(3), 3);
    }

    #[test]
    fn eating_floors_at_zero_and_scales_by_quantity() {
        assert_eq!(hunger_after_eating(5, 2, 1), 3);
        assert_eq!(hunger_after_eating(5, 2, 2), 1);
        assert_eq!(hunger_after_eating(1, 3, 1), 0);
        assert_eq!(hunger_after_eating(5, 0, 9), 5);
    }

    #[test]
    fn death_marker_is_distinct_from_starvation_streak() {
        assert!(!is_dead(0));
        assert!(!is_dead(STARVATION_TICKS));
        assert!(is_dead(DEAD_STARVATION));
    }
}
