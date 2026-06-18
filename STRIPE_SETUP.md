# Stripe setup for Magic Read

Follow these in order. Do everything in **Test mode** first (toggle in the top-right of the Stripe Dashboard), confirm the upgrade flow works, then repeat steps 3–6 in **Live mode** to take real money.

---

## 1. Create / activate your Stripe account

1. Go to https://stripe.com and sign up (or log in).
2. To receive real payouts you must **activate** the account: Dashboard → complete "Activate payments" (business/personal details + a bank account for payouts).
   - You can build and test everything in Test mode *before* activating. Activation is only required for live payments.

---

## 2. Get your secret API key

1. Dashboard → **Developers → API keys**.
2. Copy the **Secret key**.
   - Test mode key starts with `sk_test_...`
   - Live mode key starts with `sk_live_...`
3. This goes into `STRIPE_SECRET_KEY` (see step 7).

---

## 3. Create the product and three prices

1. Dashboard → **Products → Add product**.
2. Name it e.g. **Magic Read Pro**. Save.
3. On the product, add **three prices** (use "Add another price"):

   | Plan      | Amount | Billing type            | Notes                  |
   |-----------|--------|-------------------------|------------------------|
   | Monthly   | $6.99  | **Recurring** – Monthly | —                      |
   | Annual    | $49.00 | **Recurring** – Yearly  | (your "save 41%" plan) |
   | Lifetime  | $89.00 | **One time**            | not recurring          |

   ⚠️ Monthly and Annual **must** be *Recurring*. Lifetime **must** be *One time*. The code relies on this (lifetime uses a one-time payment, the others are subscriptions).

4. After saving, click each price and copy its **Price ID** (looks like `price_1AbC...`). You'll have three:
   - Monthly  → `STRIPE_PRICE_MONTHLY`
   - Annual   → `STRIPE_PRICE_ANNUAL`
   - Lifetime → `STRIPE_PRICE_LIFETIME`

> Tip: Price IDs are different in Test vs Live mode. When you go live, you'll create the prices again in Live mode and copy the new IDs.

---

## 4. Create the webhook

1. Dashboard → **Developers → Webhooks → Add endpoint**.
2. **Endpoint URL:**
   ```
   https://magic-read.onrender.com/api/stripe-webhook
   ```
3. **Select events to send** — add exactly these three:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Save, then open the endpoint and copy its **Signing secret** (starts with `whsec_...`).
5. This goes into `STRIPE_WEBHOOK_SECRET`.

---

## 5. Set the environment variables locally (`.env`)

Open `backend/.env` and fill in the real values (replace the `..._...` placeholders):

```
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx
STRIPE_PRICE_MONTHLY=price_xxxxxxxxxxxx
STRIPE_PRICE_ANNUAL=price_xxxxxxxxxxxx
STRIPE_PRICE_LIFETIME=price_xxxxxxxxxxxx
LIFETIME_OFFER_ENABLED=false
LIFETIME_OFFER_WINDOW_DAYS=7
```

The lifetime price is not a permanent public plan. It is hidden and blocked by
the backend unless `LIFETIME_OFFER_ENABLED=true`. When enabled, it is available
only for the configured number of days after a user's Pro trial ends. Keep the
flag off unless you intentionally run a limited founding-customer promotion.

---

## 6. Set the same variables on Render

Render does **not** read your local `.env`. Add them in the dashboard:

1. Render Dashboard → your service → **Environment**.
2. Add the same five keys/values as above.
3. Save → Render redeploys automatically (which also runs `npm install`, pulling in the `stripe` package).

---

## 7. Test the whole flow (Test mode)

1. Open the app, log in, click the avatar → **Upgrade to Pro ✨** → pick a plan.
2. On the Stripe Checkout page use a test card:
   - Card number: `4242 4242 4242 4242`
   - Any future expiry, any CVC, any ZIP.
3. Complete payment. You should be redirected back to the app.
4. Confirm the user's `plan` flipped to `pro`:
   - In Supabase → Table editor → `profiles`, the row's `plan` should now be `pro`.
   - In the app, the dropdown should show the **Pro ✨** badge.
5. (Optional) Test downgrade: Stripe Dashboard → Customers → cancel the test subscription → the `customer.subscription.deleted` webhook flips the plan back to `free`. (Lifetime never downgrades — it's a permanent one-time purchase.)

---

## 8. Go live

1. Switch the Dashboard to **Live mode**.
2. Redo **step 3** (create the three prices) and **step 4** (create the webhook) in Live mode.
3. Copy the **live** secret key, **live** signing secret, and **live** price IDs.
4. Update those five values on **Render** (and locally if you run live there).
5. Do one real purchase to confirm, then you're live. Stripe pays out to your bank on its payout schedule.

---

### Quick reference — the five variables

| Variable                | Where to find it                                  |
|-------------------------|---------------------------------------------------|
| `STRIPE_SECRET_KEY`     | Developers → API keys → Secret key                |
| `STRIPE_WEBHOOK_SECRET` | Developers → Webhooks → your endpoint → Signing secret |
| `STRIPE_PRICE_MONTHLY`  | Products → Magic Read Pro → Monthly price ID      |
| `STRIPE_PRICE_ANNUAL`   | Products → Magic Read Pro → Annual price ID       |
| `STRIPE_PRICE_LIFETIME` | Products → Magic Read Pro → Lifetime price ID     |
