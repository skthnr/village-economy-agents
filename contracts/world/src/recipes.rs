use crate::state::Season;

pub static ALL_ITEMS: [&str; 18] = [
    "wheat",
    "flour",
    "bread",
    "meat",
    "milk",
    "eggs",
    "vegetables",
    "herbs",
    "medicine",
    "iron_ore",
    "coal",
    "iron_tools",
    "timber",
    "firewood",
    "furniture",
    "ale",
    "meal",
    "cloth",
];

pub struct Recipe {
    pub output: &'static str,
    pub base_qty: u128,
    pub inputs: &'static [(&'static str, u128)],
    pub location: &'static str,
    pub skill: &'static str,
    pub needs_tool: bool,
}

/// The 18 origin recipes, in origin table order. Every recipe has one output.
pub static RECIPES: [Recipe; 18] = [
    Recipe {
        output: "wheat",
        base_qty: 4,
        inputs: &[],
        location: "Farm 1",
        skill: "farmer",
        needs_tool: true,
    },
    Recipe {
        output: "milk",
        base_qty: 3,
        inputs: &[],
        location: "Farm 2",
        skill: "cattle",
        needs_tool: false,
    },
    Recipe {
        output: "meat",
        base_qty: 2,
        inputs: &[],
        location: "Farm 2",
        skill: "cattle",
        needs_tool: true,
    },
    Recipe {
        output: "eggs",
        base_qty: 2,
        inputs: &[],
        location: "Farm 3",
        skill: "farmer",
        needs_tool: false,
    },
    Recipe {
        output: "vegetables",
        base_qty: 3,
        inputs: &[],
        location: "Farm 3",
        skill: "farmer",
        needs_tool: true,
    },
    Recipe {
        output: "flour",
        base_qty: 2,
        inputs: &[("wheat", 3)],
        location: "Mill",
        skill: "miller",
        needs_tool: false,
    },
    Recipe {
        output: "bread",
        base_qty: 4,
        inputs: &[("flour", 1)],
        location: "Bakery",
        skill: "baker",
        needs_tool: false,
    },
    Recipe {
        output: "iron_tools",
        base_qty: 1,
        inputs: &[("iron_ore", 2), ("coal", 1)],
        location: "Forge",
        skill: "blacksmith",
        needs_tool: false,
    },
    Recipe {
        output: "furniture",
        base_qty: 1,
        inputs: &[("timber", 3)],
        location: "Carpenter Shop",
        skill: "carpenter",
        needs_tool: true,
    },
    Recipe {
        output: "medicine",
        base_qty: 1,
        inputs: &[("herbs", 3)],
        location: "Healer's Hut",
        skill: "healer",
        needs_tool: false,
    },
    Recipe {
        output: "ale",
        base_qty: 4,
        inputs: &[("wheat", 2)],
        location: "Tavern",
        skill: "tavern",
        needs_tool: false,
    },
    Recipe {
        output: "meal",
        base_qty: 3,
        inputs: &[("meat", 1), ("vegetables", 1)],
        location: "Tavern",
        skill: "tavern",
        needs_tool: false,
    },
    Recipe {
        output: "cloth",
        base_qty: 1,
        inputs: &[],
        location: "Seamstress Cottage",
        skill: "seamstress",
        needs_tool: false,
    },
    Recipe {
        output: "timber",
        base_qty: 3,
        inputs: &[],
        location: "Forest",
        skill: "woodcutter",
        needs_tool: true,
    },
    Recipe {
        output: "firewood",
        base_qty: 4,
        inputs: &[],
        location: "Forest",
        skill: "woodcutter",
        needs_tool: true,
    },
    Recipe {
        output: "herbs",
        base_qty: 2,
        inputs: &[],
        location: "Forest",
        skill: "healer",
        needs_tool: false,
    },
    Recipe {
        output: "iron_ore",
        base_qty: 3,
        inputs: &[],
        location: "Mine",
        skill: "miner",
        needs_tool: true,
    },
    Recipe {
        output: "coal",
        base_qty: 2,
        inputs: &[],
        location: "Mine",
        skill: "miner",
        needs_tool: true,
    },
];

/// Season multipliers in basis points, in `ALL_ITEMS` order:
/// spring, summer, autumn, winter.
pub const SEASON_BPS: [[u32; 4]; 18] = [
    [1200, 1500, 1000, 0],
    [1000, 1000, 1000, 1000],
    [1000, 1000, 1000, 1000],
    [1000, 1000, 1200, 800],
    [1200, 1000, 800, 600],
    [1500, 1000, 800, 500],
    [1200, 1500, 1000, 0],
    [1500, 1200, 800, 0],
    [1000, 1000, 1000, 1000],
    [1000, 1000, 1000, 800],
    [1000, 1000, 1000, 1200],
    [1000, 1000, 1000, 1000],
    [1000, 1000, 1200, 800],
    [800, 800, 1200, 1500],
    [1000, 1000, 1000, 1000],
    [1000, 1200, 1500, 1000],
    [1000, 1000, 1000, 1000],
    [1000, 1000, 1000, 1200],
];

/// Base recipe quantities in `ALL_ITEMS` order (the recipe table order differs).
const RECIPE_BASE_QTY: [u128; 18] = [
    4, 2, 4, 2, 3, 2, 3, 2, 1, 3, 2, 1, 3, 4, 1, 4, 3, 1,
];

const fn season_column(season: &Season) -> usize {
    match season {
        Season::Spring => 0,
        Season::Summer => 1,
        Season::Autumn => 2,
        Season::Winter => 3,
    }
}

const fn build_production_qty() -> [[u128; 4]; 18] {
    let mut table = [[0u128; 4]; 18];
    let mut item = 0;
    while item < 18 {
        let mut season = 0;
        while season < 4 {
            table[item][season] =
                RECIPE_BASE_QTY[item] * (SEASON_BPS[item][season] as u128) / 1_000;
            season += 1;
        }
        item += 1;
    }
    table
}

/// Base quantity x season multiplier, precomputed per item/season.
pub const PRODUCTION_QTY: [[u128; 4]; 18] = build_production_qty();

pub fn canonical_item_rank(item: &str) -> usize {
    match item {
        "wheat" => 0,
        "flour" => 1,
        "bread" => 2,
        "meat" => 3,
        "milk" => 4,
        "eggs" => 5,
        "vegetables" => 6,
        "herbs" => 7,
        "medicine" => 8,
        "iron_ore" => 9,
        "coal" => 10,
        "iron_tools" => 11,
        "timber" => 12,
        "firewood" => 13,
        "furniture" => 14,
        "ale" => 15,
        "meal" => 16,
        "cloth" => 17,
        _ => usize::MAX,
    }
}

pub fn season_multiplier_bps(item: &str, season: &Season) -> u32 {
    let index = canonical_item_rank(item);
    if index == usize::MAX {
        return 1000;
    }
    SEASON_BPS[index][season_column(season)]
}

pub fn production_quantity(item: &str, season: &Season) -> Option<u128> {
    let index = canonical_item_rank(item);
    (index != usize::MAX).then(|| PRODUCTION_QTY[index][season_column(season)])
}
pub fn recipe_for(item: &str) -> Option<&'static Recipe> {
    RECIPES.iter().find(|recipe| recipe.output == item)
}

/// Origin quantity math: floor(base x season), both factors in thousandths.
/// The origin labor bonus (1.5) belongs to the deferred labor
/// routing feature, so no labor factor exists here.
pub fn apply_multipliers(base: u128, season_bps: u32) -> u128 {
    base * (season_bps as u128) / 1_000
}

/// Farm items may be produced at any of the three farms; herbs only in the
/// Forest. All other recipes require their exact location. Village-qualified
/// names ("Brunnfeld:Farm 1") are matched on the bare location.
pub fn valid_production_location(item: &str, recipe_location: &str, location: &str) -> bool {
    let bare = location.rsplit(':').next().unwrap_or(location);
    if bare == recipe_location {
        return true;
    }
    let aliases: &[&str] = match item {
        "wheat" | "vegetables" | "eggs" => &["Farm 1", "Farm 2", "Farm 3"],
        "herbs" => &["Forest"],
        _ => &[],
    };
    aliases.contains(&bare)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn farm_aliases_match_all_farms() {
        assert!(valid_production_location("wheat", "Farm 1", "Farm 3"));
        assert!(valid_production_location("vegetables", "Farm 3", "Farm 2"));
        assert!(valid_production_location("eggs", "Farm 3", "Farm 1"));
        assert!(valid_production_location("herbs", "Forest", "Brunnfeld:Forest"));
        assert!(!valid_production_location("bread", "Bakery", "Farm 1"));
        assert!(!valid_production_location("wheat", "Farm 1", "Mill"));
    }

    #[test]
    fn production_qty_table_matches_multipliers() {
        let seasons = [Season::Spring, Season::Summer, Season::Autumn, Season::Winter];
        for item in ALL_ITEMS {
            let recipe = recipe_for(item).unwrap_or_else(|| panic!("missing recipe for {item}"));
            for season in seasons {
                assert_eq!(
                    production_quantity(item, &season),
                    Some(apply_multipliers(
                        recipe.base_qty,
                        season_multiplier_bps(item, &season)
                    )),
                    "qty table mismatch for {item} in {:?}",
                    season
                );
            }
        }
    }
}
