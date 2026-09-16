# @miblox/auth

Sign-in for MiBlox, built on [Migood Games OAuth](https://www.welltypers.it.com).

## How accounts work

A MiBlox account is **ours**. It has its own id and its own username, and the
player can change that username whenever they like. Migood is the identity the
account is *linked* to — it is not the source of the display name.

```
Migood identity                MiBlox account
---------------                --------------
id: 12            <--link-->   id:       9f3c-...  (never changes)
username: someone              username: BlockBuilder  (player can change freely)
```

Because the two are separate:

- A player renaming themselves on Migood keeps the same MiBlox account.
- A player renaming themselves on MiBlox does not touch their Migood account.

### Which key the link uses

`/api/sendinfo` returns a stable **numeric `id`**; `/api/oauth/userinfo` does
not — it only returns a username. So the link prefers the numeric id and falls
back to the Migood username when no id is available.

**Worth knowing:** an account created through the redirect or device-code flow
alone has no numeric id recorded, so if that player renames themselves on
Migood before ever playing through the in-frame SDK, their next login looks
like a new player. The first SDK login backfills the id and closes that gap
permanently (there is a test covering exactly this). If MiBlox is published on
Migood Games, players hit the SDK path by default and this never comes up.

## The four login flows

| Flow | Use it for | Entry point |
| --- | --- | --- |
| In-frame SDK token | MiBlox running on Migood Games | `loginWithGameToken(token)` |
| Authorization code | Our own website build | `authorizeUrl(...)` then `loginWithAuthCode(...)` |
| Device code | Desktop, VR and console, where there is no redirect | `startDeviceLogin()` then `completeDeviceLogin(...)` |
| Built-in webhook | Servers with no web frontend at all | `handleVerificationWebhook(body, signature)` |

### In-frame SDK (preferred)

The browser gets a game token from the Migood SDK and posts it to our server,
which verifies it with the client secret:

```js
// client
await Migood.requestAuth(["identity"]);
const token = Migood.getToken();
// POST that token to the MiBlox server

// server
const { account, session } = await auth.loginWithGameToken(token);
```

### Device code (desktop / VR)

No browser redirect is involved, so this works on a headset or a native client:

```js
const { user_code, device_code } = await auth.startDeviceLogin(["identify"]);
// Show user_code to the player; they type it into Migood -> profile -> Enter Code.
// Poll until it stops throwing `pending`:
const { account, session } = await auth.completeDeviceLogin(device_code);
```

Never show `device_code` to the player — it is the secret half of the pair.

## Sessions

After any flow, the server issues its own HMAC-signed session token. The game
server checks that on each connection instead of calling Migood every time.
Tokens carry the account id and expiry; the account is re-read from the store
on every verification so a rename or ban takes effect immediately.

## Configuration

The client secret is server-side only and is read from the environment:

```
MIBLOX_MIGOOD_CLIENT_ID=your_client_id
MIBLOX_MIGOOD_CLIENT_SECRET=your_client_secret
MIBLOX_MIGOOD_WEBHOOK_SECRET=optional_webhook_signing_secret
MIBLOX_SESSION_SECRET=a_long_random_string
```

`MIBLOX_SESSION_SECRET` must stay stable across restarts, or every session is
invalidated. If none of these are set the server runs in guest mode, which is
what you want for local development and for `Migood.available === false`.

## Storage

`AccountStore` is an interface. `JsonAccountStore` writes a JSON file (atomic
rename, serialized writes) and is fine for a single server; implement the same
interface against a real database when there is more than one.
