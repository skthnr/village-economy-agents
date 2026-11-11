use near_sdk::{env, json_types::U128, near, AccountId, NearToken};
use near_sdk_contract_tools::{
    ft::*,
    owner::Owner,
    Owner,
};

const STORAGE_MIN_YOCTO: u128 = 2_500_000_000_000_000_000_000;

#[derive(Default, Owner, FungibleToken)]
#[near(contract_state)]
pub struct Coin {}

#[near]
impl Coin {
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128, metadata: ContractMetadata) -> Self {
        let mut contract = Self {};

        Owner::init(&mut contract, &owner_id);
        contract.set_metadata(&metadata);
        contract.set_storage_balance_bounds(&StorageBalanceBounds {
            min: NearToken::from_yoctonear(STORAGE_MIN_YOCTO),
            max: None,
        });

        if let Err(error) =
            <Self as Nep141Controller>::deposit_unchecked(&mut contract, owner_id.as_ref(), total_supply.0)
        {
            env::panic_str(&format!("coin initial supply deposit failed: {error}"));
        }

        contract
    }
}
