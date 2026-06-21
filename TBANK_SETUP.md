# T-Bank payments setup (Russian cards + SBP)

Magic Read uses T-Bank's hosted payment form. If SBP and card payments are
enabled for the virtual terminal, the customer can choose either method on the
T-Bank page. Terminal credentials stay on the backend.

## 1. Supabase

Run `backend/07-tbank-payments-setup.sql` once in Supabase SQL Editor. It adds:

- `profiles.plan_ends_at` and `profiles.plan_provider`;
- an idempotent payment log;
- the atomic `apply_tbank_payment` function.

Do this before the first test payment. Without it, T-Bank notifications return
an error and will not grant Pro access.

## 2. Render environment

Add these environment variables to the backend service:

```text
TBANK_TERMINAL_KEY=<test or production terminal key>
TBANK_PASSWORD=<terminal password>
TBANK_NOTIFICATION_URL=https://magic-read.onrender.com/api/tbank/notification
TBANK_RETURN_URL=https://magicread.app
```

Optional API override (normally omit it):

```text
TBANK_API_URL=https://securepay.tinkoff.ru/v2
```

Never put the terminal password in frontend code or Git.

## 3. T-Business cabinet

For the selected internet shop and virtual terminal:

1. Enable SBP and Russian card payments.
2. Set the notification URL to the URL above if the cabinet asks for it.
3. Test the terminal, then activate the production terminal.
4. Connect an online cash register/receipt service before accepting real
   payments. The current test integration does not send receipt fiscalization
   fields because taxation and VAT settings must match the IP.

## 4. Products

- Month: `1,000 ₽`, grants 30 days.
- Year: `9,000 ₽`, grants 365 days.
- Payments are one-time. There is no automatic renewal or unapproved charge.

Repeated notifications are safe: one T-Bank `PaymentId` can extend access only
once. Pro is granted only for a valid signed `CONFIRMED` notification whose
amount matches the selected plan.
