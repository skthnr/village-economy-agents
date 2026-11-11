use crate::state::Season;

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
