# Elysium: oracle configuration

Prepares separate EVM entries for staging and production. The oracle uses the Elysium depository for the matching environment.

## Files

- `chains.mainnets.stag.json.example`: entry for `configs/chains.mainnets.stag.json`.
- `chains.mainnets.prod.json.example`: entry for `configs/chains.mainnets.prod.json`.

## Complete this draft

- [ ] Confirm the chain ID against the mainnet RPC.
- [ ] Set both deployed depository addresses from verified deployment records.
- [ ] Confirm the required finality policy for the Orbit chain.
- [ ] Supply `ELYSIUM_RPC_URL` to every peer through the infrastructure PR.
- [ ] Insert the entries into the active files after the proxy works.
- [ ] Verify staging attestations, including the selected finality behavior.

## Network data

The [official specifications](https://elysium.kinetiq.xyz/docs/chain-specifications) publish chain ID `99801` for testnet. Mainnet details remain pending as of October 16, 2026. All `ELYSIUM_` markers in the examples require confirmed mainnet values. Numeric markers must become JSON numbers where the target schema requires numbers.

The examples stay outside the active configuration paths. Keep this PR in draft until the remaining steps pass.
