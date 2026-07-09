# Magic Read iOS Packaging

This project uses Capacitor to package the existing `frontend/` app as an iOS app.

## Current Status

- Capacitor is installed at the project root.
- The iOS project has been generated in `ios/`.
- `frontend/` has been copied into `ios/App/App/public`.
- The iOS app name is `Magic Read`.
- The starter bundle identifier is `com.magicread.app`.
- Microphone and speech-recognition permission text has been added for pronunciation practice.

## What Goes Into The iPhone App

- `frontend/` is bundled into the iOS app.
- `backend/` stays hosted online.
- The app currently points at `https://magic-read.onrender.com` in `frontend/app.js`.

## Local Commands

Install dependencies:

```bash
npm install
```

Sync the web app into the iOS project:

```bash
npm run cap:sync
```

Open the iOS project in Xcode:

```bash
npm run cap:open:ios
```

Run on a connected iPhone or simulator:

```bash
npm run cap:run:ios
```

## Before App Store Submission

- Set the final bundle identifier in Xcode if `com.magicread.app` is not the one you want.
- Add your Apple Developer team under Signing & Capabilities.
- Replace generated placeholder app icons with final Magic Read icons.
- Test microphone permission, login, reading, speaking, flashcards, video captions, and upgrade flows on a real iPhone.
- Decide how iOS subscriptions will work. If users buy Pro inside the iOS app, Apple usually expects In-App Purchase.

## Xcode Steps

1. Run `npm run cap:open:ios`.
2. In Xcode, select the `App` project.
3. Open **Signing & Capabilities**.
4. Choose your Apple team when you have one.
5. Run on a simulator or connected iPhone.
6. When ready for App Store upload, use **Product > Archive**.
