use near_sdk::{
    env,
    json_types::U128,
    near,
    AccountId,
    Gas,
    NearToken,
    Promise,
    PromiseError,
    PromiseOrValue,
};

use crate::{
    events::Event,
    external::{ext_coin, ext_items, ext_self},
    market::{
        expires_at, fill_cost, fill_id, fill_quantity, index_from_ring, is_expired, order_id,
        parse_buy_msg, parse_sell_msg, push_price, trade_id, trade_volume_slot,
        BUY_ORDER_DEPOSIT_YOCTO, MT_TRANSFER_DEPOSIT_YOCTO,
    },
    recipes::canonical_item_rank,
    state::{BuyFill, Order, OrderSide},
    World,
    WorldExt,
};

const GAS_FOR_TOKEN_CALL: Gas = Gas::from_tgas(30);
const GAS_FOR_COIN_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const SEQUENCE_LIMIT: u64 = 1 << 20;

#[near]
impl World {
    /// Post a BUY (demand) order. Sells are escrowed through `mt_on_transfer`.
    /// The deposit pays for the order record and is refunded on cancel/expire.
    #[payable]
    pub fn post_order(&mut self, item: String, quantity: U128, price: U128) -> u64 {
        let agent = env::predecessor_account_id();
        if self.agents.get(&agent).is_none() {
            env::panic_str("post_order: predecessor is not a registered agent");
        }
        let quantity = quantity.0;
        let price = price.0;
        if quantity == 0 || price == 0 {
            env::panic_str("post_order: quantity and price must be greater than zero");
        }
        if env::attached_deposit() != NearToken::from_yoctonear(BUY_ORDER_DEPOSIT_YOCTO) {
            env::panic_str("post_order: attach exactly the 0.01 NEAR order deposit");
        }

        let cost = price
            .checked_mul(quantity)
            .unwrap_or_else(|| env::panic_str("post_order: price x quantity overflows"));
        if self.mirror_coin(&agent) < cost {
            env::panic_str("post_order: wallet cannot cover price x quantity");
        }

        let id = self.next_order_id();
        self.orders.insert(
            id,
            Order {
                id,
                agent_id: agent.clone(),
                side: OrderSide::Buy,
                item: item.clone(),
                quantity,
                price,
                posted_tick: self.tick,
                expires_at: expires_at(self.tick),
            },
        );
        Event::OrderPosted {
            order_id: id,
            agent_id: agent,
            order_type: "buy".to_string(),
            item,
            quantity: U128(quantity),
            price: U128(price),
        }
        .emit();

        id
    }

    /// Cancel one of the caller's own orders. Sells return the escrowed stock;
    /// BUY orders return the fixed record deposit.
    pub fn cancel_order(&mut self, order_id: u64) -> Promise {
        let agent = env::predecessor_account_id();
        let order = self
            .orders
            .get(&order_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("cancel_order: unknown order"));
        if order.agent_id != agent {
            env::panic_str("cancel_order: only the order owner may cancel");
        }
        self.orders.remove(&order_id);

        let order_type = match order.side {
            OrderSide::Sell => "sell",
            OrderSide::Buy => "buy",
        };
        Event::OrderCancelled {
            order_id: order.id,
            agent_id: order.agent_id.clone(),
            order_type: order_type.to_string(),
            item: order.item.clone(),
            quantity: U128(order.quantity),
            price: U128(order.price),
        }
        .emit();

        match order.side {
            OrderSide::Sell => {
                self.mirror_add_item(&order.agent_id, &order.item, order.quantity);
                ext_items::ext(self.items_contract.clone())
                    .with_static_gas(GAS_FOR_TOKEN_CALL)
                    .with_attached_deposit(NearToken::from_yoctonear(MT_TRANSFER_DEPOSIT_YOCTO))
                    .mt_transfer(
                        order.agent_id,
                        order.item,
                        U128(order.quantity),
                        None,
                        None,
                    )
            }
            OrderSide::Buy => Promise::new(order.agent_id)
                .transfer(NearToken::from_yoctonear(BUY_ORDER_DEPOSIT_YOCTO)),
        }
    }

    /// NEP-141 receiver. `msg = "buy:<order_id>:<max_price>"`.
    ///
    /// The item transfer + settlement callback are a detached promise chain:
    /// the FT contract needs this method's immediate return value to be the
    /// unused amount, so the chain must not be joined into the return value.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.coin_contract {
            env::panic_str("ft_on_transfer: only the coin contract may call");
        }
        let (target_order_id, max_price) = parse_buy_msg(&msg)
            .unwrap_or_else(|| env::panic_str("ft_on_transfer: malformed buy message"));
        if self.agents.get(&sender_id).is_none() {
            return PromiseOrValue::Value(amount);
        }

        let order = self
            .orders
            .get(&target_order_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("ft_on_transfer: unknown order"));
        if order.side != OrderSide::Sell {
            env::panic_str("ft_on_transfer: order is not a sell order");
        }
        if is_expired(order.expires_at, self.tick) {
            env::panic_str("ft_on_transfer: order has expired");
        }
        if order.agent_id == sender_id {
            env::panic_str("ft_on_transfer: seller cannot buy their own order");
        }
        if order.price > max_price {
            env::panic_str("ft_on_transfer: order price exceeds max_price");
        }
        let buyer_location = self.location_of(&sender_id);
        if buyer_location.rsplit(':').next().unwrap_or(buyer_location.as_str())
            != "Village Square"
        {
            env::panic_str("ft_on_transfer: buyer must be at Village Square");
        }

        let quantity = fill_quantity(amount.0, order.price, order.quantity);
        if quantity == 0 {
            return PromiseOrValue::Value(amount);
        }
        let cost = fill_cost(quantity, order.price)
            .unwrap_or_else(|| env::panic_str("ft_on_transfer: cost overflows"));
        let unused = amount.0.saturating_sub(cost);

        if let Some(stored) = self.orders.get_mut(&target_order_id) {
            stored.quantity = stored.quantity.saturating_sub(quantity);
        }
        self.mirror_remove_coin(&sender_id, cost);

        let fill = self.next_fill_id();
        self.pending_fills.insert(
            fill,
            BuyFill {
                fill_id: fill,
                order_id: target_order_id,
                buyer: sender_id.clone(),
                quantity,
                cost,
            },
        );
        let _ = ext_items::ext(self.items_contract.clone())
            .with_static_gas(GAS_FOR_TOKEN_CALL)
            .with_attached_deposit(NearToken::from_yoctonear(MT_TRANSFER_DEPOSIT_YOCTO))
            .mt_transfer(
                sender_id.clone(),
                order.item,
                U128(quantity),
                None,
                None,
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CALLBACK)
                    .on_buy_fill(fill, target_order_id, sender_id),
            );

        PromiseOrValue::Value(U128(unused))
    }

    /// NEP-245 receiver. `msg = "sell:<price>"`; the full amount is accepted
    /// into world escrow and becomes an Order with `expires_at = tick + 16`.
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        if env::predecessor_account_id() != self.items_contract {
            env::panic_str("mt_on_transfer: only the items contract may call");
        }
        let _ = previous_owner_ids;
        if token_ids.len() != 1 || amounts.len() != 1 {
            env::panic_str("mt_on_transfer: exactly one token per sell order");
        }
        let price = parse_sell_msg(&msg)
            .unwrap_or_else(|| env::panic_str("mt_on_transfer: malformed sell message"));
        let quantity = amounts[0].0;
        if quantity == 0 || price == 0 {
            env::panic_str("mt_on_transfer: quantity and price must be greater than zero");
        }
        if self.agents.get(&sender_id).is_none() {
            env::panic_str("mt_on_transfer: seller is not a registered agent");
        }

        let token_id = token_ids[0].clone();
        let id = self.next_order_id();
        self.mirror_remove_item(&sender_id, &token_id, quantity);
        self.orders.insert(
            id,
            Order {
                id,
                agent_id: sender_id.clone(),
                side: OrderSide::Sell,
                item: token_id.clone(),
                quantity,
                price,
                posted_tick: self.tick,
                expires_at: expires_at(self.tick),
            },
        );
        Event::OrderPosted {
            order_id: id,
            agent_id: sender_id,
            order_type: "sell".to_string(),
            item: token_id,
            quantity: U128(quantity),
            price: U128(price),
        }
        .emit();

        PromiseOrValue::Value(vec![U128(0)])
    }

    /// Commit or refund one buy after the items transfer settles.
    #[private]
    pub fn on_buy_fill(
        &mut self,
        fill_id: u64,
        order_id: u64,
        buyer: AccountId,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let Some(fill) = self.pending_fills.remove(&fill_id) else {
            env::log_str("on_buy_fill: unknown fill id; ignoring");
            return;
        };
        let order = self.orders.get(&order_id).cloned();

        match result {
            Ok(()) => match order {
                Some(order) => {
                    self.record_item_receipt(&buyer, &order.item, fill.quantity);
                    let seller = order.agent_id.clone();
                    if order.quantity == 0 {
                        self.orders.remove(&order_id);
                    }
                    self.mirror_add_coin(&seller, fill.cost);
                    self.update_price_index(&order.item, order.price);

                    let slot = trade_volume_slot(self.tick);
                    self.trade_volume[slot] =
                        self.trade_volume[slot].saturating_add(fill.cost);
                    let settled_trade_id = trade_id(self.tick, self.next_trade_seq);
                    self.next_trade_seq = self.next_trade_seq.saturating_add(1);

                    Event::TradeCompleted {
                        tick: self.tick,
                        order_id,
                        trade_id: settled_trade_id,
                        buyer: buyer.clone(),
                        seller: seller.clone(),
                        item: order.item.clone(),
                        quantity: U128(fill.quantity),
                        price_per_unit: U128(order.price),
                        total: U128(fill.cost),
                    }
                    .emit();
                    self.pay_coin(seller, fill.cost);

                    if order.item == "iron_tools" {
                        let equipped = self
                            .agents
                            .get(&buyer)
                            .map(|profile| profile.tool.is_some())
                            .unwrap_or(false);
                        let durability =
                            self.tool_state.get(&buyer).copied().unwrap_or(0);
                        if !equipped || durability == 0 {
                            self.mirror_remove_item(&buyer, "iron_tools", 1);
                            self.equip_tool(&buyer);
                            self.push_feedback(
                                &buyer,
                                "You equipped a fresh set of iron tools.",
                            );
                        }
                    }
                }
                None => {
                    // The order vanished between fill and commit; do not trap
                    // the buyer's coin.
                    self.mirror_add_coin(&buyer, fill.cost);
                    self.pay_coin(buyer.clone(), fill.cost);
                    self.push_feedback(
                        &buyer,
                        "Your purchase could not be settled; the cost was refunded.",
                    );
                }
            },
            Err(_) => {
                if let Some(stored) = self.orders.get_mut(&order_id) {
                    stored.quantity = stored.quantity.saturating_add(fill.quantity);
                }
                self.mirror_add_coin(&buyer, fill.cost);
                self.pay_coin(buyer.clone(), fill.cost);
                self.push_feedback(&buyer, "Your purchase failed. The cost was refunded.");
            }
        }
    }
}

impl World {
    fn next_order_id(&mut self) -> u64 {
        if self.next_order_seq >= SEQUENCE_LIMIT {
            env::panic_str("order sequence exhausted for this tick");
        }
        let id = order_id(self.tick, self.next_order_seq);
        self.next_order_seq += 1;
        id
    }

    fn next_fill_id(&mut self) -> u64 {
        if self.next_fill_seq >= SEQUENCE_LIMIT {
            env::panic_str("fill sequence exhausted");
        }
        let id = fill_id(self.tick, self.next_fill_seq);
        self.next_fill_seq += 1;
        id
    }

    fn pay_coin(&mut self, receiver: AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let _ = ext_coin::ext(self.coin_contract.clone())
            .with_static_gas(GAS_FOR_COIN_TRANSFER)
            .with_attached_deposit(ONE_YOCTO)
            .ft_transfer(receiver, U128(amount), None);
    }

    /// Expire orders whose full TTL has passed. Sells return escrow, BUY orders
    /// return the record deposit. Called from every `run_tick`.
    pub(crate) fn prune_expired_orders(&mut self) {
        let tick = self.tick;
        let expired: Vec<Order> = self
            .orders
            .values()
            .filter(|order| is_expired(order.expires_at, tick))
            .cloned()
            .collect();
        for order in expired {
            self.orders.remove(&order.id);
            let order_type = match order.side {
                OrderSide::Sell => "sell",
                OrderSide::Buy => "buy",
            };
            Event::OrderExpired {
                order_id: order.id,
                agent_id: order.agent_id.clone(),
                order_type: order_type.to_string(),
                item: order.item.clone(),
                quantity: U128(order.quantity),
                price: U128(order.price),
            }
            .emit();

            match order.side {
                OrderSide::Sell => {
                    self.mirror_add_item(&order.agent_id, &order.item, order.quantity);
                    self.push_feedback(
                        &order.agent_id,
                        format!(
                            "Your sell order for {} {} expired.",
                            order.quantity, order.item
                        ),
                    );
                    let _ = ext_items::ext(self.items_contract.clone())
                        .with_static_gas(GAS_FOR_TOKEN_CALL)
                        .with_attached_deposit(NearToken::from_yoctonear(
                            MT_TRANSFER_DEPOSIT_YOCTO,
                        ))
                        .mt_transfer(
                            order.agent_id,
                            order.item,
                            U128(order.quantity),
                            None,
                            None,
                        );
                }
                OrderSide::Buy => {
                    self.push_feedback(
                        &order.agent_id,
                        format!(
                            "Your buy order for {} {} expired; the deposit was refunded.",
                            order.quantity, order.item
                        ),
                    );
                    let _ = Promise::new(order.agent_id)
                        .transfer(NearToken::from_yoctonear(BUY_ORDER_DEPOSIT_YOCTO));
                }
            }
        }
    }

    /// Push one settled price into the item's 10-slot ring and re-derive the
    /// integer rounded-mean index.
    pub(crate) fn update_price_index(&mut self, item: &str, price: u128) {
        let key = item.to_string();
        let mut ring = self.trade_price_ring.get(&key).cloned().unwrap_or_default();
        push_price(&mut ring, u64::try_from(price).unwrap_or(u64::MAX));
        if let Some(index) = index_from_ring(&ring) {
            self.price_index.insert(key.clone(), index);
        }
        self.trade_price_ring.insert(key, ring);
    }

    pub(crate) fn mirror_add_item(&mut self, agent: &AccountId, item: &str, quantity: u128) {
        if quantity == 0 {
            return;
        }
        let mut inventory = self
            .item_balance_mirror
            .get(agent)
            .cloned()
            .unwrap_or_default();
        match inventory.iter_mut().find(|(name, _)| name.as_str() == item) {
            Some((_, value)) => *value = value.saturating_add(quantity),
            None => inventory.push((item.to_string(), quantity)),
        }
        inventory.sort_by(|left, right| {
            canonical_item_rank(&left.0)
                .cmp(&canonical_item_rank(&right.0))
                .then(left.0.cmp(&right.0))
        });
        self.item_balance_mirror.insert(agent.clone(), inventory);
    }

    pub(crate) fn mirror_remove_item(&mut self, agent: &AccountId, item: &str, quantity: u128) {
        if quantity == 0 {
            return;
        }
        let Some(mut inventory) = self.item_balance_mirror.get(agent).cloned() else {
            return;
        };
        let Some(position) = inventory.iter().position(|(name, _)| name.as_str() == item) else {
            return;
        };
        let remaining = inventory[position].1.saturating_sub(quantity);
        if remaining == 0 {
            inventory.remove(position);
        } else {
            inventory[position].1 = remaining;
        }
        self.item_balance_mirror.insert(agent.clone(), inventory);
    }

    pub(crate) fn mirror_add_coin(&mut self, agent: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let next = self.mirror_coin(agent).saturating_add(amount);
        self.coin_balance_mirror.insert(agent.clone(), next);
    }

    pub(crate) fn mirror_remove_coin(&mut self, agent: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let next = self.mirror_coin(agent).saturating_sub(amount);
        self.coin_balance_mirror.insert(agent.clone(), next);
    }
}
