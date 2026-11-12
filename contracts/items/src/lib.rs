use near_sdk::{env, json_types::U128, near, AccountId, NearToken, PanicOnDefault};
use near_sdk_contract_tools::{
    mt::*,
    owner::Owner,
    Owner,
};

const STORAGE_MIN_YOCTO: u128 = 2_500_000_000_000_000_000_000;

#[derive(MultiToken, Owner, PanicOnDefault)]
#[near(contract_state)]
pub struct Items {}

#[near]
impl Items {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        let mut contract = Self {};

        Owner::init(&mut contract, &owner_id);
        contract.set_contract_metadata(&ContractMetadata::new("eidolon items"));
        contract.set_storage_balance_bounds(&StorageBalanceBounds {
            min: NearToken::from_yoctonear(STORAGE_MIN_YOCTO),
            max: None,
        });

        contract
    }

    pub fn mint(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        memo: Option<String>,
    ) {
        Self::require_owner();

        if amount.0 == 0 {
            env::panic_str("items mint amount must be greater than zero");
        }

        let mut mint = Nep245Mint::single(token_id, amount.0, receiver_id);
        if let Some(memo) = memo {
            mint = mint.memo(memo);
        }

        if let Err(error) = <Self as Nep245Controller>::mint(self, &mint) {
            env::panic_str(&format!("items mint failed: {error}"));
        }
    }

    pub fn burn(&mut self, owner_id: AccountId, token_id: String, amount: U128) {
        Self::require_owner();

        if amount.0 == 0 {
            env::panic_str("items burn amount must be greater than zero");
        }

        let burn = Nep245Burn::single(token_id, amount.0, owner_id);

        if let Err(error) = <Self as Nep245Controller>::burn(self, &burn) {
            env::panic_str(&format!("items burn failed: {error}"));
        }
    }
}
