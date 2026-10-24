# Deriv API reference used by the market selector

The server asks Deriv for its active basic-options symbols using `active_symbols: "brief"` and `product_type: "basic"`. Deriv's official [Code Examples](https://developers.deriv.com/docs/examples/) show that exact request and an `active_symbols` response array.

For each candidate, the server sends `contracts_for: <symbol>` and retains it only when the returned `contracts_for.available` contains both `contract_type: "CALL"` and `contract_type: "PUT"`. The official [Contracts for API comparison](https://developers.deriv.com/comparison/contracts-for/) documents the new request as a symbol-only request and shows `available[].contract_type` in the response. The server deliberately does not send legacy request fields such as `currency` or `product_type` to `contracts_for`.

The market list is read-only and cached for two minutes. The selected symbol is then checked against that server-side catalog before settings are persisted. Before trading is enabled, the existing start flow still requests CALL and PUT proposals using the exact configured duration and unit; if Deriv rejects the duration, the start preflight fails without a purchase.

These references document the API shape; this deliverable did not connect to a Deriv account or verify live market availability.
