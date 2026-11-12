use crate::tick::TICKS_PER_DAY;

pub const INITIAL_PRICE_INDEX: [(&str, u64); 18] = [
    ("wheat", 2),
    ("flour", 5),
    ("bread", 3),
    ("meat", 8),
    ("milk", 2),
    ("iron_tools", 15),
    ("coal", 3),
    ("iron_ore", 4),
    ("timber", 3),
    ("firewood", 2),
    ("herbs", 1),
    ("medicine", 10),
    ("ale", 3),
    ("meal", 6),
    ("cloth", 5),
    ("furniture", 12),
    ("eggs", 1),
    ("vegetables", 2),
];

pub const PRICE_RING_CAP: usize = 10;
pub const ORDER_TTL: u64 = 16;
/// Refundable storage deposit for one BUY order record (10 millinear).
pub const BUY_ORDER_DEPOSIT_YOCTO: u128 = 10_000_000_000_000_000_000_000;
/// One-yocto deposit attached to every outbound `items::mt_transfer`.
pub const MT_TRANSFER_DEPOSIT_YOCTO: u128 = 1;

pub fn initial_price(item: &str) -> Option<u64> {
    INITIAL_PRICE_INDEX
        .iter()
        .find(|(known, _)| *known == item)
        .map(|(_, price)| *price)
}

pub fn order_id(tick: u64, seq: u64) -> u64 {
    (tick << 20) | seq
}

pub fn fill_id(tick: u64, seq: u64) -> u64 {
    (tick << 20) | seq
}

pub fn trade_id(tick: u64, seq: u64) -> u64 {
    (tick << 20) | seq
}

pub fn expires_at(tick: u64) -> u64 {
    tick + ORDER_TTL
}

/// Origin expiry semantics: an order is gone once `tick` reaches its
/// `expires_at` (`expiresAtTick <= time.tick`), so it is fillable only through
/// the preceding tick.
pub fn is_expired(order_expires_at: u64, tick: u64) -> bool {
    order_expires_at <= tick
}

/// Parses the NEP-141 receiver payload `buy:<order_id>:<max_price>`.
pub fn parse_buy_msg(msg: &str) -> Option<(u64, u128)> {
    let mut parts = msg.split(':');
    let prefix = parts.next()?;
    let order = parts.next()?;
    let max_price = parts.next()?;
    if prefix != "buy" || parts.next().is_some() {
        return None;
    }
    Some((order.parse().ok()?, max_price.parse().ok()?))
}

/// Parses the NEP-245 receiver payload `sell:<price>`.
pub fn parse_sell_msg(msg: &str) -> Option<u128> {
    let mut parts = msg.split(':');
    let prefix = parts.next()?;
    let price = parts.next()?;
    if prefix != "sell" || parts.next().is_some() {
        return None;
    }
    price.parse().ok()
}

/// Buyer quantity for a fill: `floor(amount / price)` capped by the order.
pub fn fill_quantity(amount: u128, price: u128, order_quantity: u128) -> u128 {
    if price == 0 {
        return 0;
    }
    (amount / price).min(order_quantity)
}

/// Exact coin cost of a fill, or `None` on overflow.
pub fn fill_cost(quantity: u128, price: u128) -> Option<u128> {
    quantity.checked_mul(price)
}

/// The mean price of the last `PRICE_RING_CAP` trades.
pub fn index_from_ring(ring: &[u64]) -> Option<u64> {
    mean_price(ring)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_is_capped_and_oldest_prices_drop() {
        let mut ring = Vec::new();
        for price in 1..=12 {
            push_price(&mut ring, price);
        }
        assert_eq!(
            ring,
            vec![3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            "ring keeps only the latest cap"
        );
        assert_eq!(index_from_ring(&ring), Some(8));
        assert_eq!(index_from_ring(&[]), None);
        assert_eq!(index_from_ring(&[4, 5]), Some(5));
        assert_eq!(index_from_ring(&[1, 2]), Some(2));
        assert_eq!(index_from_ring(&[3, 4]), Some(4));
    }

    #[test]
    fn deterministic_ids_pack_tick_and_sequence() {
        assert_eq!(order_id(1, 0), 1 << 20);
        assert_eq!(order_id(1, 2), (1 << 20) | 2);
        assert_eq!(fill_id(3, 4), (3 << 20) | 4);
        assert_eq!(trade_id(5, 6), (5 << 20) | 6);
        assert_eq!(order_id(7, (1 << 20) - 1), (7 << 20) | ((1 << 20) - 1));
    }

    #[test]
    fn expiry_boundary_matches_origin() {
        let posted = 1;
        assert_eq!(expires_at(posted), posted + ORDER_TTL);
        assert!(!is_expired(expires_at(posted), posted));
        assert!(!is_expired(expires_at(posted), expires_at(posted) - 1));
        assert!(is_expired(expires_at(posted), expires_at(posted)));
        assert!(!is_expired(17, 1));
        assert!(is_expired(17, 17));
    }

    #[test]
    fn receiver_messages_parse_strictly() {
        assert_eq!(parse_buy_msg("buy:42:7"), Some((42, 7)));
        assert_eq!(parse_buy_msg("buy:1:0"), Some((1, 0)));
        assert_eq!(parse_buy_msg("buy:42"), None);
        assert_eq!(parse_buy_msg("buy:42:7:9"), None);
        assert_eq!(parse_buy_msg("sell:42:7"), None);
        assert_eq!(parse_buy_msg("buy:x:7"), None);
        assert_eq!(parse_sell_msg("sell:9"), Some(9));
        assert_eq!(parse_sell_msg("sell:0"), Some(0));
        assert_eq!(parse_sell_msg("sell:"), None);
        assert_eq!(parse_sell_msg("sell:9:1"), None);
        assert_eq!(parse_sell_msg("buy:9"), None);
    }

    #[test]
    fn fills_floor_and_cap() {
        assert_eq!(fill_quantity(10, 3, 5), 3);
        assert_eq!(fill_quantity(10, 3, 2), 2);
        assert_eq!(fill_quantity(2, 3, 5), 0);
        assert_eq!(fill_quantity(10, 0, 5), 0);
        assert_eq!(fill_cost(3, 3), Some(9));
        assert_eq!(fill_cost(u128::MAX, 2), None);
        assert_eq!(BUY_ORDER_DEPOSIT_YOCTO, 10_000_000_000_000_000_000_000);
    }
}

pub fn push_price(ring: &mut Vec<u64>, price: u64) {
    ring.push(price);
    if ring.len() > PRICE_RING_CAP {
        let excess = ring.len() - PRICE_RING_CAP;
        ring.drain(0..excess);
    }
}

pub fn mean_price(ring: &[u64]) -> Option<u64> {
    let count = ring.len();
    if count == 0 {
        return None;
    }
    let sum: u128 = ring.iter().map(|price| *price as u128).sum();
    let rounded = (sum + (count as u128) / 2) / count as u128;
    Some(u64::try_from(rounded).unwrap_or(u64::MAX))
}

pub fn trade_volume_slot(tick: u64) -> usize {
    (tick % TICKS_PER_DAY) as usize
}
