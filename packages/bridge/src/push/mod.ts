/**
 * Web Push (DESIGN-v2 T11): VAPID keys in `<state>/vapid.json`, subscriptions in `<state>/push.json`, RFC 8291
 * `aes128gcm` with WebCrypto, alerts when a status leaves `working` for `blocked` / `done` / `idle` / `error`,
 * deduplicated by `(address, turn)`, muted while a device is visible, endpoints limited to the three push services.
 * Use {@link PushService}.
 */

export {
  ALERT_KINDS,
  ALERT_TITLES,
  type AlertKind,
  AlertTracker,
  MAX_REMEMBERED_ALERTS,
  type PushAlert,
} from "./alerts.ts";
export {
  type AlertSource,
  PUSH_KEY_PATH,
  PUSH_TTL_S,
  type PushDelivery,
  type PushPayload,
  pushPayload,
  PushService,
  type PushServiceOptions,
  SEND_TIMEOUT_MS,
} from "./service.ts";
export {
  ensureVapidKeys,
  MAX_ENDPOINT_LENGTH,
  MAX_SUBSCRIPTIONS,
  PUSH_FILE,
  type StoredSubscription,
  subscriptionProblem,
  SubscriptionStore,
  VAPID_FILE,
} from "./store.ts";
export {
  decodeSubscriptionKeys,
  type EncryptOptions,
  encryptPayload,
  fromBase64url,
  isAllowedEndpoint,
  MAX_PAYLOAD_BYTES,
  PUSH_SERVICE_HOSTS,
  RECORD_SIZE,
  type SubscriptionKeyBytes,
  type SubscriptionKeys,
  VAPID_TOKEN_TTL_S,
  vapidAuthorization,
  type VapidKeys,
} from "./webpush.ts";
