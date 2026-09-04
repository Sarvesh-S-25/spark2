import type { Field, Seam, SplitModule, Capability } from '../splitter/schemas.js';

/**
 * The rule table behind the offline provider.
 *
 * This is not machine learning and does not pretend to be. It is a library of
 * well-known project shapes — a map view, a login, a chat, a file upload — each
 * with the seams and modules that shape always needs. When a brief mentions one,
 * SparkX can produce a real, correct, contract-closed split with no model at all.
 *
 * Two reasons this exists:
 *   1. The app must be fully usable and demoable with no API key and no network.
 *   2. It is the fixture the splitter's own validations are tested against.
 */

export const F = (
  name: string,
  type: Field['type'],
  required = true,
  description = '',
): Field => ({ name, type, required, description });

type PartialSeam = Omit<Seam, 'capability_ids' | 'summary' | 'method' | 'path' | 'symbol' | 'input' | 'output' | 'output_is_array' | 'errors'>
  & Partial<Seam>;

const seam = (s: PartialSeam): Seam => ({
  summary: '',
  capability_ids: [],
  method: '',
  path: '',
  symbol: '',
  input: [],
  output: [],
  output_is_array: false,
  errors: [],
  ...s,
});

type PartialModule = Pick<SplitModule, 'slug' | 'name' | 'lane' | 'kind'> & Partial<SplitModule>;

const mod = (m: PartialModule): SplitModule => ({
  summary: '',
  responsibilities: [],
  non_goals: [],
  provides: [],
  consumes: [],
  files: [],
  acceptance: [],
  est_size: 'M',
  ...m,
});

export interface Feature {
  id: string;
  match: RegExp;
  capabilities: Omit<Capability, 'source_quote'>[];
  seams: Seam[];
  modules: SplitModule[];
}

// ─────────────────────────────────────────────────────────────────────────────

const mapFeature: Feature = {
  id: 'map',
  match: /\b(map|maps|geo|geograph\w*|marker|markers|track(?:er|ing)?|vehicle|fleet|route|location|gps|latitude|longitude)\b/i,
  capabilities: [
    { id: 'see-map', text: 'see a map centred on a sensible default region', actor: 'end user' },
    { id: 'see-markers', text: 'see markers on the map that update as things move', actor: 'end user' },
    { id: 'tap-marker', text: 'tap a marker to see that item’s details', actor: 'end user' },
    { id: 'pan-zoom', text: 'pan and zoom the map by touch', actor: 'end user' },
    { id: 'report-position', text: 'report a current position to the system', actor: 'device' },
  ],
  seams: [
    seam({
      key: 'map.config', kind: 'config', direction: 'server_to_client',
      summary: 'Tile provider and default viewport, served once at startup.',
      capability_ids: ['see-map'], method: 'GET', path: '/api/map/config', symbol: 'MAP_CONFIG',
      output: [
        F('tileUrl', 'string', true, 'XYZ tile template'),
        F('defaultCenterLat', 'number'), F('defaultCenterLng', 'number'),
        F('defaultZoom', 'number'), F('maxZoom', 'number', false),
      ],
    }),
    seam({
      key: 'Marker', kind: 'type', direction: 'shared',
      summary: 'One thing shown on the map.',
      capability_ids: ['see-markers'], symbol: 'Marker',
      output: [
        F('id', 'id'), F('lat', 'number'), F('lng', 'number'),
        F('label', 'string'), F('kind', 'string'),
        F('headingDeg', 'number', false), F('updatedAt', 'datetime'),
      ],
    }),
    seam({
      key: 'markers.list', kind: 'http', direction: 'client_to_server',
      summary: 'Markers currently inside the visible bounding box.',
      capability_ids: ['see-markers'], method: 'GET', path: '/api/markers',
      input: [
        F('bbox', 'number[]', true, 'west, south, east, north'),
        F('since', 'datetime', false, 'only markers updated after this instant'),
      ],
      output: [
        F('id', 'id'), F('lat', 'number'), F('lng', 'number'),
        F('label', 'string'), F('kind', 'string'), F('updatedAt', 'datetime'),
      ],
      output_is_array: true,
      errors: [{ code: 'BBOX_INVALID', when: 'bbox is not [w,s,e,n]', http: 400 }],
    }),
    seam({
      key: 'markers.detail', kind: 'http', direction: 'client_to_server',
      summary: 'Full detail for one marker, loaded on tap.',
      capability_ids: ['tap-marker'], method: 'GET', path: '/api/markers/:id',
      input: [F('id', 'id')],
      output: [
        F('id', 'id'), F('label', 'string'), F('kind', 'string'),
        F('speedKph', 'number', false), F('lastSeenAt', 'datetime'),
        F('history', 'object[]', false, 'recent positions'),
      ],
      errors: [{ code: 'MARKER_NOT_FOUND', when: 'no marker with that id', http: 404 }],
    }),
    seam({
      key: 'markers.stream', kind: 'event', direction: 'server_to_client',
      summary: 'Movement events pushed to every client watching that area.',
      capability_ids: ['see-markers'], symbol: 'marker.moved',
      output: [
        F('id', 'id'), F('lat', 'number'), F('lng', 'number'),
        F('headingDeg', 'number', false), F('at', 'datetime'),
      ],
    }),
    seam({
      key: 'positions.ingest', kind: 'http', direction: 'device_to_server',
      summary: 'A device or vehicle reporting where it is.',
      capability_ids: ['report-position'], method: 'POST', path: '/api/positions',
      input: [
        F('deviceId', 'id'), F('lat', 'number'), F('lng', 'number'),
        F('headingDeg', 'number', false), F('at', 'datetime'),
      ],
      output: [F('accepted', 'number')],
      errors: [{ code: 'COORDS_INVALID', when: 'lat/lng out of range', http: 400 }],
    }),
    seam({
      key: 'positions.store', kind: 'function', direction: 'server_internal',
      summary: 'Persistence boundary for position history and latest-per-device.',
      capability_ids: ['report-position', 'see-markers'], symbol: 'positionStore',
      input: [F('deviceId', 'id'), F('lat', 'number'), F('lng', 'number'), F('at', 'datetime')],
      output: [F('written', 'boolean')],
    }),
    seam({
      key: 'map.viewport', kind: 'function', direction: 'client_internal',
      summary: 'Current viewport, published by the canvas to every layer above it.',
      capability_ids: ['pan-zoom', 'see-markers'], symbol: 'useViewport',
      output: [
        F('bbox', 'number[]'), F('zoom', 'number'),
        F('centerLat', 'number'), F('centerLng', 'number'),
      ],
    }),
  ],
  modules: [
    mod({
      slug: 'fe.map-canvas', name: 'Map canvas', lane: 'frontend', kind: 'ui_component',
      summary: 'Renders the base map, owns viewport state, publishes it to sibling layers.',
      responsibilities: ['mount the tile provider', 'own centre and zoom', 'publish viewport changes'],
      non_goals: ['marker rendering', 'gesture interpretation'],
      provides: ['map.viewport'], consumes: ['map.config'],
      files: ['src/map/MapCanvas.tsx', 'src/map/useViewport.ts'],
      acceptance: [
        'renders a map centred on map.config default centre',
        'publishes map.viewport within 100ms of a pan settling',
      ],
    }),
    mod({
      slug: 'fe.marker-layer', name: 'Marker layer', lane: 'frontend', kind: 'ui_component',
      summary: 'Draws markers for the current viewport and applies live movement events.',
      responsibilities: ['fetch markers for the bbox', 'diff and animate positions'],
      non_goals: ['owning the viewport', 'websocket lifecycle'],
      consumes: ['markers.list', 'markers.stream', 'map.viewport', 'Marker'],
      files: ['src/map/MarkerLayer.tsx'],
      acceptance: ['re-queries within 300ms of a viewport change', 'moves a marker on a marker.moved event'],
    }),
    mod({
      slug: 'fe.gesture-controller', name: 'Gesture controller', lane: 'frontend', kind: 'ui_component',
      summary: 'Touch pan, pinch zoom and inertia, translated into viewport commands.',
      responsibilities: ['pointer and touch handling', 'inertia and clamping'],
      non_goals: ['any network access at all'],
      consumes: ['map.viewport'],
      files: ['src/map/GestureController.tsx'],
      acceptance: ['two-finger pinch changes zoom', 'flick produces decaying inertia'],
      est_size: 'S',
    }),
    mod({
      slug: 'fe.marker-detail-sheet', name: 'Marker detail sheet', lane: 'frontend', kind: 'ui_component',
      summary: 'Bottom sheet showing one marker’s detail when it is tapped.',
      consumes: ['markers.detail'],
      non_goals: ['fetching the marker list'],
      files: ['src/map/MarkerDetailSheet.tsx'],
      acceptance: ['opens within 150ms of a tap', 'shows a spinner while detail loads'],
      est_size: 'S',
    }),
    mod({
      slug: 'fe.live-connection', name: 'Live connection', lane: 'frontend', kind: 'state_store',
      summary: 'Websocket lifecycle: connect, resubscribe on viewport change, reconnect with backoff.',
      responsibilities: ['reconnect with backoff', 'backfill missed events after a drop'],
      non_goals: ['rendering anything'],
      consumes: ['markers.stream'],
      files: ['src/live/useLiveConnection.ts'],
      acceptance: ['reconnects within 5s of a dropped socket'],
    }),
    mod({
      slug: 'be.map-config', name: 'Map config service', lane: 'backend', kind: 'api_route',
      summary: 'Serves tile provider settings and the default viewport.',
      provides: ['map.config'],
      files: ['server/routes/mapConfig.ts'],
      acceptance: ['returns a valid tile template'],
      est_size: 'S',
    }),
    mod({
      slug: 'be.markers-service', name: 'Markers service', lane: 'backend', kind: 'service',
      summary: 'Bounding-box queries and single-marker detail lookup.',
      responsibilities: ['bbox query', 'detail lookup', 'rate limiting'],
      non_goals: ['ingesting positions', 'websocket fan-out'],
      provides: ['markers.list', 'markers.detail'], consumes: ['positions.store', 'Marker'],
      files: ['server/services/markers.ts', 'server/routes/markers.ts'],
      acceptance: ['bbox query returns only markers inside the box', 'unknown id returns MARKER_NOT_FOUND'],
    }),
    mod({
      slug: 'be.realtime-hub', name: 'Realtime hub', lane: 'backend', kind: 'service',
      summary: 'Fans movement events out to subscribers, filtered by their bounding box.',
      provides: ['markers.stream'], consumes: ['positions.store'],
      non_goals: ['persisting anything'],
      files: ['server/realtime/hub.ts'],
      acceptance: ['a client only receives events inside its subscribed bbox'],
    }),
    mod({
      slug: 'be.positions-ingest', name: 'Position ingest', lane: 'backend', kind: 'api_route',
      summary: 'Validates incoming position reports and hands them to the store.',
      provides: ['positions.ingest'], consumes: ['positions.store'],
      files: ['server/routes/positions.ts'],
      acceptance: ['rejects out-of-range coordinates with COORDS_INVALID'],
      est_size: 'S',
    }),
    mod({
      slug: 'be.position-store', name: 'Position store', lane: 'backend', kind: 'adapter',
      summary: 'Time-series persistence plus a latest-position-per-device index.',
      provides: ['positions.store'],
      non_goals: ['any HTTP concern'],
      files: ['server/store/positions.ts'],
      acceptance: ['latest-per-device lookup is O(1) on the index'],
    }),
  ],
};

const authFeature: Feature = {
  id: 'auth',
  match: /\b(login|log in|sign ?in|sign ?up|auth\w*|account|register|password|session|user account)\b/i,
  capabilities: [
    { id: 'sign-in', text: 'sign in with an email and password', actor: 'end user' },
    { id: 'stay-signed-in', text: 'stay signed in across page reloads', actor: 'end user' },
  ],
  seams: [
    seam({
      key: 'Session', kind: 'type', direction: 'shared', symbol: 'Session',
      summary: 'The signed-in user as the client sees them.',
      capability_ids: ['sign-in'],
      output: [F('userId', 'id'), F('email', 'string'), F('displayName', 'string'), F('roles', 'string[]', false)],
    }),
    seam({
      key: 'auth.login', kind: 'http', direction: 'client_to_server',
      summary: 'Exchange credentials for a session token.',
      capability_ids: ['sign-in'], method: 'POST', path: '/api/auth/login',
      input: [F('email', 'string'), F('password', 'string')],
      output: [F('token', 'string'), F('userId', 'id'), F('expiresAt', 'datetime')],
      errors: [
        { code: 'BAD_CREDENTIALS', when: 'email or password does not match', http: 401 },
        { code: 'RATE_LIMITED', when: 'too many attempts', http: 429 },
      ],
    }),
    seam({
      key: 'auth.me', kind: 'http', direction: 'client_to_server',
      summary: 'Who am I, according to the token I am holding.',
      capability_ids: ['stay-signed-in'], method: 'GET', path: '/api/auth/me',
      output: [F('userId', 'id'), F('email', 'string'), F('displayName', 'string')],
      errors: [{ code: 'UNAUTHENTICATED', when: 'token missing or expired', http: 401 }],
    }),
    seam({
      key: 'auth.session', kind: 'function', direction: 'client_internal', symbol: 'useSession',
      summary: 'Current session as every other frontend module reads it.',
      capability_ids: ['stay-signed-in'],
      output: [F('userId', 'id', false), F('displayName', 'string', false), F('isSignedIn', 'boolean')],
    }),
  ],
  modules: [
    mod({
      slug: 'fe.login-form', name: 'Login form', lane: 'frontend', kind: 'ui_component',
      summary: 'Email and password form with inline validation and error states.',
      consumes: ['auth.login'], non_goals: ['storing the token'],
      files: ['src/auth/LoginForm.tsx'],
      acceptance: ['shows a field-level error for BAD_CREDENTIALS'], est_size: 'S',
    }),
    mod({
      slug: 'fe.session-store', name: 'Session store', lane: 'frontend', kind: 'state_store',
      summary: 'Holds the token, restores the session on load, exposes it to the app.',
      provides: ['auth.session'], consumes: ['auth.me', 'Session'],
      files: ['src/auth/useSession.ts'],
      acceptance: ['a reload with a valid token keeps the user signed in'],
    }),
    mod({
      slug: 'be.auth-service', name: 'Auth service', lane: 'backend', kind: 'service',
      summary: 'Credential verification, token issuing and token introspection.',
      provides: ['auth.login', 'auth.me'], consumes: ['Session'],
      non_goals: ['password reset emails'],
      files: ['server/routes/auth.ts', 'server/services/auth.ts'],
      acceptance: ['passwords are stored hashed, never in plain text', 'expired tokens return UNAUTHENTICATED'],
    }),
  ],
};

const chatFeature: Feature = {
  id: 'chat',
  match: /\b(chat|message|messaging|comment|conversation|thread|inbox)\b/i,
  capabilities: [
    { id: 'read-messages', text: 'read the messages in a conversation', actor: 'end user' },
    { id: 'send-message', text: 'send a message to a conversation', actor: 'end user' },
    { id: 'see-new-messages', text: 'see new messages arrive without refreshing', actor: 'end user' },
  ],
  seams: [
    seam({
      key: 'Message', kind: 'type', direction: 'shared', symbol: 'Message',
      capability_ids: ['read-messages'],
      output: [F('id', 'id'), F('authorId', 'id'), F('body', 'string'), F('sentAt', 'datetime')],
    }),
    seam({
      key: 'messages.list', kind: 'http', direction: 'client_to_server',
      summary: 'A page of messages in a conversation, newest last.',
      capability_ids: ['read-messages'], method: 'GET', path: '/api/conversations/:id/messages',
      input: [F('id', 'id'), F('before', 'datetime', false), F('limit', 'number', false)],
      output: [F('id', 'id'), F('authorId', 'id'), F('body', 'string'), F('sentAt', 'datetime')],
      output_is_array: true,
    }),
    seam({
      key: 'messages.send', kind: 'http', direction: 'client_to_server',
      capability_ids: ['send-message'], method: 'POST', path: '/api/conversations/:id/messages',
      input: [F('id', 'id'), F('body', 'string')],
      output: [F('id', 'id'), F('sentAt', 'datetime')],
      errors: [{ code: 'MESSAGE_EMPTY', when: 'body is blank', http: 400 }],
    }),
    seam({
      key: 'messages.stream', kind: 'event', direction: 'server_to_client', symbol: 'message.created',
      capability_ids: ['see-new-messages'],
      output: [F('conversationId', 'id'), F('id', 'id'), F('authorId', 'id'), F('body', 'string'), F('sentAt', 'datetime')],
    }),
  ],
  modules: [
    mod({
      slug: 'fe.message-list', name: 'Message list', lane: 'frontend', kind: 'ui_component',
      summary: 'Scrollback with paging, grouping and live append.',
      consumes: ['messages.list', 'messages.stream', 'Message'],
      files: ['src/chat/MessageList.tsx'],
      acceptance: ['stays pinned to the bottom when already at the bottom'],
    }),
    mod({
      slug: 'fe.composer', name: 'Composer', lane: 'frontend', kind: 'ui_component',
      summary: 'Message input with optimistic send.',
      consumes: ['messages.send'], non_goals: ['rendering the scrollback'],
      files: ['src/chat/Composer.tsx'], est_size: 'S',
      acceptance: ['shows the message immediately and reconciles on response'],
    }),
    mod({
      slug: 'be.messages-service', name: 'Messages service', lane: 'backend', kind: 'service',
      provides: ['messages.list', 'messages.send'], consumes: ['Message'],
      files: ['server/routes/messages.ts'],
      acceptance: ['rejects a blank body with MESSAGE_EMPTY'],
    }),
    mod({
      slug: 'be.chat-hub', name: 'Chat hub', lane: 'backend', kind: 'service',
      summary: 'Broadcasts new messages to everyone in the conversation.',
      provides: ['messages.stream'],
      files: ['server/realtime/chatHub.ts'], est_size: 'S',
      acceptance: ['a subscriber receives a message within 200ms of send'],
    }),
  ],
};

const uploadFeature: Feature = {
  id: 'upload',
  match: /\b(upload|attach\w*|file|files|image|images|photo|photos|document|documents|pdf)\b/i,
  capabilities: [{ id: 'upload-file', text: 'upload a file and see it attached', actor: 'end user' }],
  seams: [
    seam({
      key: 'FileRef', kind: 'type', direction: 'shared', symbol: 'FileRef',
      capability_ids: ['upload-file'],
      output: [F('id', 'id'), F('name', 'string'), F('sizeBytes', 'number'), F('mimeType', 'string'), F('url', 'string')],
    }),
    seam({
      key: 'files.upload', kind: 'http', direction: 'client_to_server',
      summary: 'Accepts one file and returns a durable reference to it.',
      capability_ids: ['upload-file'], method: 'POST', path: '/api/files',
      input: [F('name', 'string'), F('mimeType', 'string'), F('sizeBytes', 'number')],
      output: [F('id', 'id'), F('url', 'string')],
      errors: [
        { code: 'FILE_TOO_LARGE', when: 'over the configured size limit', http: 413 },
        { code: 'MIME_NOT_ALLOWED', when: 'type is not in the allow list', http: 415 },
      ],
    }),
  ],
  modules: [
    mod({
      slug: 'fe.file-picker', name: 'File picker', lane: 'frontend', kind: 'ui_component',
      summary: 'Drag-and-drop and click-to-browse with progress and per-file errors.',
      consumes: ['files.upload', 'FileRef'], files: ['src/files/FilePicker.tsx'],
      acceptance: ['shows a per-file progress bar', 'surfaces FILE_TOO_LARGE against the offending file'],
    }),
    mod({
      slug: 'be.file-store', name: 'File store', lane: 'backend', kind: 'service',
      summary: 'Validates, stores and serves uploaded files.',
      provides: ['files.upload'], consumes: ['FileRef'],
      files: ['server/routes/files.ts'],
      acceptance: ['enforces the size limit before writing anything to disk'],
    }),
  ],
};

const searchFeature: Feature = {
  id: 'search',
  match: /\b(search|filter|query|find|lookup|autocomplete)\b/i,
  capabilities: [{ id: 'search', text: 'search and filter the available items', actor: 'end user' }],
  seams: [
    seam({
      key: 'search.query', kind: 'http', direction: 'client_to_server',
      summary: 'Full-text search with paging.',
      capability_ids: ['search'], method: 'GET', path: '/api/search',
      input: [F('q', 'string'), F('limit', 'number', false), F('offset', 'number', false)],
      output: [F('id', 'id'), F('title', 'string'), F('snippet', 'string'), F('score', 'number')],
      output_is_array: true,
      errors: [{ code: 'QUERY_TOO_SHORT', when: 'q is under 2 characters', http: 400 }],
    }),
  ],
  modules: [
    mod({
      slug: 'fe.search-bar', name: 'Search bar', lane: 'frontend', kind: 'ui_component',
      summary: 'Debounced input, result list, empty and error states.',
      consumes: ['search.query'], files: ['src/search/SearchBar.tsx'], est_size: 'S',
      acceptance: ['debounces to at most one request per 250ms'],
    }),
    mod({
      slug: 'be.search-service', name: 'Search service', lane: 'backend', kind: 'service',
      provides: ['search.query'], files: ['server/routes/search.ts'],
      acceptance: ['returns results ordered by descending score'],
    }),
  ],
};

const dashboardFeature: Feature = {
  id: 'dashboard',
  // Deliberately does not match a bare "report": "vehicles report their
  // position" is not a request for a dashboard, and that false positive grows a
  // whole pair of modules nobody asked for.
  match: /\b(dashboard|analytics?|chart|charts|graph|graphs|statistics?|stats|metrics?|kpis?)\b/i,
  capabilities: [{ id: 'see-stats', text: 'see summary numbers and trends for the chosen period', actor: 'end user' }],
  seams: [
    seam({
      key: 'stats.summary', kind: 'http', direction: 'client_to_server',
      summary: 'Headline numbers plus a series for the chosen period.',
      capability_ids: ['see-stats'], method: 'GET', path: '/api/stats/summary',
      input: [F('from', 'datetime'), F('to', 'datetime'), F('granularity', 'string', false)],
      output: [F('total', 'number'), F('changePct', 'number'), F('series', 'object[]')],
      errors: [{ code: 'RANGE_INVALID', when: 'from is after to', http: 400 }],
    }),
  ],
  modules: [
    mod({
      slug: 'fe.stats-panel', name: 'Stats panel', lane: 'frontend', kind: 'ui_component',
      summary: 'KPI tiles and a trend chart with a period picker.',
      consumes: ['stats.summary'], files: ['src/stats/StatsPanel.tsx'],
      acceptance: ['renders a skeleton, not a spinner, while loading'],
    }),
    mod({
      slug: 'be.stats-service', name: 'Stats service', lane: 'backend', kind: 'service',
      provides: ['stats.summary'], files: ['server/routes/stats.ts'],
      acceptance: ['a period with no data returns zeroes, not an error'],
    }),
  ],
};

const notifyFeature: Feature = {
  id: 'notify',
  match: /\b(notif\w*|alert\w*|reminder\w*|email\w*|push notification)\b/i,
  capabilities: [{ id: 'see-notifications', text: 'see notifications as they arrive', actor: 'end user' }],
  seams: [
    seam({
      key: 'notifications.list', kind: 'http', direction: 'client_to_server',
      capability_ids: ['see-notifications'], method: 'GET', path: '/api/notifications',
      input: [F('unreadOnly', 'boolean', false)],
      output: [F('id', 'id'), F('title', 'string'), F('body', 'string'), F('readAt', 'datetime', false), F('createdAt', 'datetime')],
      output_is_array: true,
    }),
    seam({
      key: 'notifications.stream', kind: 'event', direction: 'server_to_client', symbol: 'notification.created',
      capability_ids: ['see-notifications'],
      output: [F('id', 'id'), F('title', 'string'), F('body', 'string'), F('createdAt', 'datetime')],
    }),
  ],
  modules: [
    mod({
      slug: 'fe.notification-bell', name: 'Notification bell', lane: 'frontend', kind: 'ui_component',
      consumes: ['notifications.list', 'notifications.stream'],
      files: ['src/notifications/NotificationBell.tsx'], est_size: 'S',
      acceptance: ['unread count updates without a refresh'],
    }),
    mod({
      slug: 'be.notification-service', name: 'Notification service', lane: 'backend', kind: 'service',
      provides: ['notifications.list', 'notifications.stream'],
      files: ['server/routes/notifications.ts'],
      acceptance: ['marking one read does not mark the rest read'],
    }),
  ],
};

const paymentFeature: Feature = {
  id: 'payment',
  match: /\b(payment\w*|pay|checkout|billing|subscription\w*|invoice\w*|stripe|razorpay)\b/i,
  capabilities: [{ id: 'pay', text: 'pay for an order and see it confirmed', actor: 'end user' }],
  seams: [
    seam({
      key: 'checkout.create', kind: 'http', direction: 'client_to_server',
      summary: 'Creates a payment session and returns where to send the user.',
      capability_ids: ['pay'], method: 'POST', path: '/api/checkout',
      input: [F('orderId', 'id'), F('amountMinor', 'number'), F('currency', 'string')],
      output: [F('sessionId', 'id'), F('redirectUrl', 'string')],
      errors: [{ code: 'AMOUNT_INVALID', when: 'amount is zero or negative', http: 400 }],
    }),
  ],
  modules: [
    mod({
      slug: 'fe.checkout-button', name: 'Checkout button', lane: 'frontend', kind: 'ui_component',
      consumes: ['checkout.create'], files: ['src/checkout/CheckoutButton.tsx'], est_size: 'S',
      non_goals: ['handling card details directly'],
      acceptance: ['disables itself while a session is being created'],
    }),
    mod({
      slug: 'be.payment-adapter', name: 'Payment adapter', lane: 'backend', kind: 'adapter',
      summary: 'Wraps the payment provider so the rest of the backend never sees its SDK.',
      provides: ['checkout.create'], files: ['server/adapters/payment.ts'],
      acceptance: ['no provider SDK type appears outside this module'],
    }),
  ],
};

/** Used when nothing else matches: a plain list-and-create shape. */
const crudFeature: Feature = {
  id: 'crud',
  match: /\b(list|manage|create|add|edit|delete|records?|items?|entries|catalog|inventory|todo|task)\b/i,
  capabilities: [
    { id: 'see-items', text: 'see the list of items', actor: 'end user' },
    { id: 'add-item', text: 'add a new item', actor: 'end user' },
  ],
  seams: [
    seam({
      key: 'Item', kind: 'type', direction: 'shared', symbol: 'Item',
      capability_ids: ['see-items'],
      output: [F('id', 'id'), F('title', 'string'), F('status', 'string'), F('createdAt', 'datetime')],
    }),
    seam({
      key: 'items.list', kind: 'http', direction: 'client_to_server',
      capability_ids: ['see-items'], method: 'GET', path: '/api/items',
      input: [F('status', 'string', false), F('limit', 'number', false)],
      output: [F('id', 'id'), F('title', 'string'), F('status', 'string'), F('createdAt', 'datetime')],
      output_is_array: true,
    }),
    seam({
      key: 'items.create', kind: 'http', direction: 'client_to_server',
      capability_ids: ['add-item'], method: 'POST', path: '/api/items',
      input: [F('title', 'string'), F('status', 'string', false)],
      output: [F('id', 'id'), F('createdAt', 'datetime')],
      errors: [{ code: 'TITLE_REQUIRED', when: 'title is blank', http: 400 }],
    }),
    seam({
      key: 'items.store', kind: 'function', direction: 'server_internal', symbol: 'itemStore',
      capability_ids: ['see-items', 'add-item'],
      input: [F('op', 'string'), F('payload', 'object')],
      output: [F('ok', 'boolean')],
    }),
  ],
  modules: [
    mod({
      slug: 'fe.item-list', name: 'Item list', lane: 'frontend', kind: 'ui_component',
      consumes: ['items.list', 'Item'], files: ['src/items/ItemList.tsx'],
      acceptance: ['renders an empty state when the list is empty'],
    }),
    mod({
      slug: 'fe.item-form', name: 'Item form', lane: 'frontend', kind: 'ui_component',
      consumes: ['items.create'], files: ['src/items/ItemForm.tsx'], est_size: 'S',
      acceptance: ['surfaces TITLE_REQUIRED against the title field'],
    }),
    mod({
      slug: 'be.items-service', name: 'Items service', lane: 'backend', kind: 'service',
      provides: ['items.list', 'items.create'], consumes: ['items.store', 'Item'],
      files: ['server/routes/items.ts'],
      acceptance: ['create returns the new id'],
    }),
    mod({
      slug: 'be.items-store', name: 'Items store', lane: 'backend', kind: 'adapter',
      provides: ['items.store'], files: ['server/store/items.ts'],
      non_goals: ['any HTTP concern'],
      acceptance: ['schema migrations run on start'],
    }),
  ],
};

export const FEATURES: Feature[] = [
  mapFeature, authFeature, chatFeature, uploadFeature,
  searchFeature, dashboardFeature, notifyFeature, paymentFeature, crudFeature,
];

/** Always present, so even a one-line brief produces a closed graph. */
export const BASE_SEAMS: Seam[] = [
  seam({
    key: 'app.config', kind: 'config', direction: 'server_to_client',
    summary: 'Runtime settings the client needs before it can render anything.',
    method: 'GET', path: '/api/config', symbol: 'APP_CONFIG',
    output: [F('appName', 'string'), F('apiBaseUrl', 'string'), F('features', 'string[]', false)],
  }),
];

export const BASE_MODULES: SplitModule[] = [
  mod({
    slug: 'fe.app-shell', name: 'App shell', lane: 'frontend', kind: 'ui_component',
    summary: 'Routing, layout and the loading gate that waits for app config.',
    consumes: ['app.config'], files: ['src/App.tsx', 'src/routes.tsx'],
    non_goals: ['any feature-specific rendering'],
    acceptance: ['renders a loading state until app.config resolves'], est_size: 'S',
  }),
  mod({
    slug: 'be.config-service', name: 'Config service', lane: 'backend', kind: 'api_route',
    summary: 'Serves runtime settings to the client.',
    provides: ['app.config'], files: ['server/routes/config.ts'],
    acceptance: ['never returns a secret'], est_size: 'S',
  }),
];
