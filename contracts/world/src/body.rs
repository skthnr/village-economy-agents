pub const HUNGER_MAX: u8 = 5;
pub const ENERGY_MAX: u8 = 100;
pub const DURABILITY_MAX: u8 = 100;
pub const DURABILITY_LOSS: u8 = 3;
pub const STARVATION_TICKS: u8 = 3;

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

pub fn is_starved(streak: u8) -> bool {
    streak >= STARVATION_TICKS
}

pub fn energy_after_work(energy: u8) -> u8 {
    energy.saturating_sub(5)
}
