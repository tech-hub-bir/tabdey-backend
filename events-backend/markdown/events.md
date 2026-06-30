# Events Module — Feature Reference & Backend Requirements

> UI inspired by BookMyShow · Visual language follows Grab design system

---

## BookMyShow Feature Reference

### Core Features
- **Ticketing** — Movies, concerts, festivals, workshops, experiences
- **Discovery** — City filtering, search, category/date filters, trending
- **Seat Selection** — Interactive seat map, color-coded tiers, real-time lock
- **Booking & Payments** — Wallet, UPI, cards, promo codes, group booking
- **Post-Booking** — QR code ticket, booking history, cancellation, reminders
- **Social** — Ratings & reviews, wishlist, share events
- **Loyalty** — Super Pass: early access, free cancellation, discounts

---

## Backend API Requirements

> Base: `https://grab.newedge.bt/events/api`
> Auth: `Authorization: Bearer <access_token>` on all protected routes

---

### Events

#### List Events
```
GET /events
Query: q, category, city, from_date (YYYY-MM-DD), to_date (YYYY-MM-DD), page, limit
Auth: Optional

Response:
{
  "success": true,
  "data": [
    {
      "id": "101",
      "title": "Cinema Premiere: The Thunder Valley",
      "category": "cinema",           // cinema | concert | festival | workshop | experience
      "city": "Thimphu",
      "venue_name": "City Cinema Hall",
      "venue_address": "Norzin Lam, Thimphu",
      "organizer_name": "Grab Events",
      "cover_image": "/events/covers/thunder-valley.jpg",
      "start_at": "2026-04-25T18:00:00Z",
      "end_at": "2026-04-25T21:00:00Z",
      "min_price": 200,               // lowest tier price, for card display
      "is_live": false
    }
  ],
  "total": 24,
  "page": 1
}
```

#### Event Detail
```
GET /events/:id
Auth: Optional

Response:
{
  "success": true,
  "data": {
    "id": "101",
    "title": "Cinema Premiere: The Thunder Valley",
    "category": "cinema",
    "city": "Thimphu",
    "venue_name": "City Cinema Hall",
    "venue_address": "Norzin Lam, Thimphu",
    "organizer_name": "Grab Events",
    "organizer_id": "org-001",
    "cover_image": "/events/covers/thunder-valley.jpg",
    "description": "A thrilling new release...",
    "start_at": "2026-04-25T18:00:00Z",
    "end_at": "2026-04-25T21:00:00Z",
    "is_live": false,
    "avg_rating": 4.3,
    "total_reviews": 128,
    "ticket_tiers": [
      {
        "id": "tier-1",
        "name": "Regular",
        "description": "Standard seating",
        "price": 200,
        "available_seats": 50
      },
      {
        "id": "tier-2",
        "name": "VIP",
        "description": "Best seats + snacks combo",
        "price": 400,
        "available_seats": 12
      }
    ]
  }
}
```

#### Live Event (optional)
```
GET /events/live
Auth: Optional

Response:
{
  "success": true,
  "data": {
    "id": "live-001",
    "title": "Mountain Echo Music Festival",
    "artist": "DJ Karma & The Highland Sound",
    "venue": "Changlimithang Stadium, Thimphu",
    "category": "Live Concert",
    "image": "https://...",
    "viewers": 2847,
    "likes": 14200
  }
}
// Returns null data when no live event is active
```

---

### Bookings

#### Create Booking
```
POST /bookings
Auth: Required

Request:
{
  "event_id": "101",
  "tier_id": "tier-1",
  "quantity": 2,
  "attendee_names": ["Karma Dorji", "Pema Lhamo"],
  "payment_method": "WALLET"          // WALLET | CARD | UPI
}

Response:
{
  "success": true,
  "data": {
    "booking_id": "BK-20260423-001",
    "ticket_id": "TK-20260423-001",
    "ticket_code": "TD-AB12CD",        // used for QR code generation
    "event_id": "101",
    "event_title": "Cinema Premiere: The Thunder Valley",
    "tier_id": "tier-1",
    "tier_name": "Regular",
    "quantity": 2,
    "total_amount": 400,
    "payment_method": "WALLET",
    "attendee_names": ["Karma Dorji", "Pema Lhamo"],
    "event_start_at": "2026-04-25T18:00:00Z",
    "venue_name": "City Cinema Hall",
    "created_at": "2026-04-23T10:30:00Z"
  }
}
```

#### My Tickets
```
GET /bookings/me
Auth: Required

Response:
{
  "success": true,
  "data": [
    {
      "id": "BK-20260423-001",
      "ticket_id": "TK-20260423-001",
      "ticket_code": "TD-AB12CD",
      "event_id": "101",
      "event_title": "Cinema Premiere: The Thunder Valley",
      "tier_id": "tier-1",
      "tier_name": "Regular",
      "quantity": 2,
      "total_amount": 400,
      "payment_method": "WALLET",
      "attendee_names": ["Karma Dorji", "Pema Lhamo"],
      "event_start_at": "2026-04-25T18:00:00Z",
      "venue_name": "City Cinema Hall",
      "created_at": "2026-04-23T10:30:00Z"
    }
  ]
}
```

#### Cancel Booking (optional)
```
DELETE /bookings/:bookingId
Auth: Required

Response:
{
  "success": true,
  "message": "Booking cancelled. Refund of BTN 400 will be processed within 3-5 business days."
}
```

---

### Reviews

#### Submit Review
```
POST /events/:id/reviews
Auth: Required

Request:
{
  "rating": 4,                        // 1-5
  "comment": "Amazing show!"
}

Response:
{
  "success": true,
  "data": {
    "id": "rev-001",
    "rating": 4,
    "comment": "Amazing show!",
    "user_name": "Karma D.",
    "created_at": "2026-04-23T12:00:00Z"
  }
}
```

#### Get Reviews
```
GET /events/:id/reviews?page=1&limit=10
Auth: Optional

Response:
{
  "success": true,
  "data": [
    {
      "id": "rev-001",
      "rating": 4,
      "comment": "Amazing show!",
      "user_name": "Karma D.",
      "created_at": "2026-04-23T12:00:00Z"
    }
  ],
  "avg_rating": 4.3,
  "total": 128
}
```

---

### Wishlist

#### Toggle Wishlist
```
POST /wishlist/toggle
Auth: Required

Request: { "event_id": "101" }

Response:
{
  "success": true,
  "saved": true     // true = added, false = removed
}
```

#### Get Wishlist
```
GET /wishlist
Auth: Required

Response:
{
  "success": true,
  "data": ["101", "103", "105"]   // array of saved event IDs
}
```

---

## Environment Variables Required

Add to `.env`:
```
EVENTS_BASE_URL=https://grab.newedge.bt/events/api
```

---

## Frontend Integration Summary

| # | Screen | API Calls | Auth | Cinema | General |
|---|--------|-----------|------|--------|---------|
| 1 | EventsHomeScreen | `GET /events` | No | ✅ | ✅ |
| 2 | EventDetailsScreen | `GET /events/:id`, `GET /events/:id/reviews`, `GET /wishlist` | Optional | ✅ | ✅ |
| 3 | ScreeningPickerScreen | `GET /events/:id/screenings?date=` | No | ✅ | ❌ |
| 3b | SeatCountScreen | — (no API, uses data from Screen 2) | — | ✅ | ❌ |
| 4 | SeatMapScreen | `GET /screenings/:id/seats` | Optional | ✅ | ❌ |
| 5 | SeatHoldScreen | `POST /screenings/:id/seats/hold` | Yes | ✅ | ❌ |
| 6 | QuantityScreen | — (no API, uses data from Screen 2) | — | ❌ | ✅ |
| 7 | PaymentScreen | `POST /bookings` | Yes | ✅ | ✅ |
| 8 | BookingConfirmationScreen | — (data from POST /bookings response) | — | ✅ | ✅ |
| 9 | MyTicketsScreen | `GET /bookings/me` | Yes | ✅ | ✅ |
| 10 | CancelTicketScreen | `DELETE /bookings/:bookingId` | Yes | ✅ | ✅ |
| 11 | ReviewsScreen | `GET /events/:id/reviews`, `POST /events/:id/reviews` | Mixed | ✅ | ✅ |
| — | LiveEventBanner | `GET /events/live` | No | — | ✅ |
| — | WishlistScreen | `GET /wishlist`, `POST /wishlist/toggle` | Yes | ✅ | ✅ |

> **Cinema events** → Screens 1 → 2 → 3 → 3b → 4 → 5 → 7 → 8 → 9
> **All other categories** → Screens 1 → 2 → 6 → 7 → 8 → 9

---

## Frontend Screen Guide

---

### Screen 1 — EventsHomeScreen

**What the user sees:**
- Search bar (searches title + venue name)
- Filter chips: All · Cinema · Concert · Festival · Workshop · Experience
- City filter dropdown
- Horizontal date strip for date filtering
- Horizontal scroll sections: Now Showing · Coming Soon · Experiences
- Event cards: cover image, title, venue, date, "From BTN XXX"
- LIVE badge on cards where `is_live = true`

**API called on load + on every filter change:**
```
GET /events/api/events?category=cinema&city=Thimphu&from_date=2026-05-01&page=1&limit=20
```

**Response fields used per card:**
| Field | Used for |
|-------|----------|
| `id` | Navigate to EventDetailsScreen |
| `cover_image` | Card thumbnail |
| `title` | Card title |
| `category` | Active filter chip highlight |
| `venue_name` | Subtitle line |
| `city` | Location badge |
| `start_at` | Date display |
| `min_price` | "From BTN 200" label |
| `is_live` | Red LIVE badge overlay |

**Pagination:** increment `page` param when user scrolls to bottom. Append results to the list.

---

### Screen 2 — EventDetailsScreen

**What the user sees:**
- Full-width cover image at top
- Title, category badge, city name
- Date range, venue name + address
- Average star rating + total review count → taps to ReviewsScreen
- Description text (collapsible)
- Ticket price legend:
  - Cinema: "Regular BTN 200 · VIP BTN 400 · Balcony BTN 500"
  - Others: tier name + price rows with remaining seats
- Heart icon (wishlist toggle) in top right
- Bottom CTA:
  - `category === "cinema"` → **"Book Tickets"** → goes to ScreeningPickerScreen
  - Other categories → **"Buy Tickets"** → goes to QuantityScreen

**APIs called on load (run in parallel):**
```
GET /events/api/events/:id                       → event detail + ticket_tiers[]
GET /events/api/events/:id/reviews?page=1&limit=5 → 5 preview reviews
GET /events/api/wishlist                          → to check if heart is filled (auth only)
```

**Wishlist heart tap:**
```
POST /events/api/wishlist/toggle
Authorization: Bearer <token>
{ "event_id": "uuid" }
```
Response `saved: true` → fill heart red. `saved: false` → hollow heart.

**State to carry forward to next screen:**
- `event.id`, `event.title`, `event.ticket_tiers[]` (needed for SeatCountScreen pricing)

---

### Screen 3 — ScreeningPickerScreen *(Cinema only)*

**What the user sees** (exactly like BookMyShow):
```
[FRI 24] [SAT 25] [SUN 26] [MON 27] [TUE 28] [WED 29] [THU 30]
 APR      APR      APR      APR      APR      APR      APR

─────────────────────────────────────────────
City Cinema Hall — Hall I
  [10:00]  [13:30]  [~~17:00~~]  [20:30]
            Filling Fast  Housefull

City Cinema Hall — Hall II
  [10:00]  [13:30]  [17:00]  [20:30]
─────────────────────────────────────────────
```
- Selected date highlighted in red
- Greyed showtime = housefull (not tappable)
- "Filling Fast" shown when `available_seats < 20`
- Tap any active showtime → goes to SeatCountScreen

**API called on load (today's date) and on every date tap:**
```
GET /events/api/events/:id/screenings?date=2026-05-10
```

**Full response:**
```json
{
  "success": true,
  "dates": ["2026-05-10", "2026-05-11", "2026-05-12", "2026-05-13"],
  "data": {
    "2026-05-10": {
      "Hall I": {
        "hall_id": "hall-ci-h1m-0000-000000000002",
        "hall_name": "Hall I",
        "total_seats": 209,
        "shows": [
          { "id": "uuid", "show_time": "10:00", "available_seats": 180, "status": "active" },
          { "id": "uuid", "show_time": "13:30", "available_seats": 18,  "status": "active" },
          { "id": "uuid", "show_time": "17:00", "available_seats": 0,   "status": "housefull" },
          { "id": "uuid", "show_time": "20:30", "available_seats": 209, "status": "active" }
        ]
      },
      "Hall II": {
        "hall_id": "hall-ci-h2m-0000-000000000004",
        "hall_name": "Hall II",
        "total_seats": 223,
        "shows": [
          { "id": "uuid", "show_time": "10:00", "available_seats": 223, "status": "active" },
          { "id": "uuid", "show_time": "13:30", "available_seats": 100, "status": "active" },
          { "id": "uuid", "show_time": "17:00", "available_seats": 50,  "status": "active" },
          { "id": "uuid", "show_time": "20:30", "available_seats": 0,   "status": "housefull" }
        ]
      }
    }
  }
}
```

**Rendering rules:**
| Condition | Show |
|-----------|------|
| `status === "housefull"` | Grey button, strikethrough time, disabled tap |
| `available_seats < 20 && status === "active"` | Green button + "Filling Fast" label below |
| `available_seats >= 20 && status === "active"` | Green button, no label |

**State to carry forward:**
- `screening.id` (the UUID of the chosen show)
- `hall_name`, `show_date`, `show_time` (for display on next screens)

---

### Screen 3b — SeatCountScreen *(Cinema only)*

**What the user sees** (bottom sheet or new screen, shown right after tapping a showtime):
```
Cinema Premiere: The Thunder Valley
Hall I  ·  Fri, 10 May  ·  13:30

─────────────────────────────────
Regular         BTN 200    [ − ] 0 [ + ]
VIP (Premium)   BTN 400    [ − ] 0 [ + ]
Balcony         BTN 500    [ − ] 0 [ + ]
─────────────────────────────────
Total: 0 tickets  ·  BTN 0

          [  Select Seats  ]   ← disabled until count ≥ 1
```

**No API call** — prices come from `ticket_tiers[]` loaded on Screen 2.

**Rules:**
- Max per tier = `ticket_tiers[n].available_seats`
- Total tickets across all tiers must be ≥ 1 to enable the button
- The counts per tier are stored in state and passed to SeatMapScreen

> The backend does NOT enforce a ticket count. It only validates that active holds exist for every `seat_id` submitted at booking time. The frontend count controls how many seats the user can select on the map.

**State to carry forward:**
- `selectedCounts` — e.g. `{ regular: 2, premium: 0, balcony: 1 }`
- Total count (sum of all) — limits max selectable on seat map

---

### Screen 4 — SeatMapScreen *(Cinema only)*

**What the user sees:**
```
[←]  The Thunder Valley · Hall I · Fri 10 May · 13:30

         ████████  SCREEN  ████████

  Legend:  🟩 Available  🟦 Selected  ⬛ Booked  🟨 Held

  🟡 Balcony (BTN 500)
  A  [ ][ ] _ [ ][ ][ ][ ][ ][ ][ ][ ][ ][ ][ ][ ][ ][ ][ ][ ]
  B  [ ][ ] _ [ ][ ][ ][ ] _ _ [ ][ ][ ][ ][ ][ ] _ _ [ ][ ]
  ...

  🔵 Premium — Rows A–D  (BTN 400)
  🟩 Regular — Rows E–M  (BTN 200)

  A  [1][2] _ [3][4][5][6][7][8][9][10][11] _ _ [14][15]
  ...
  F  [1][2][3][4][5][6][7][8][9][10][11][12][13][14][15][16][17][18]
  ...

─────────────────────────────
  2 seats selected  ·  BTN 400     [Confirm Seats]
```

**API called on load:**
```
GET /events/api/screenings/:screeningId/seats
Authorization: Bearer <token>   (optional — for "held_by_me" status)
```

**Response:**
```json
{
  "success": true,
  "data": {
    "main": {
      "A": [
        { "id": "uuid", "seat_number": 1,  "column_position": 0,  "category": "premium",  "status": "available" },
        { "id": "uuid", "seat_number": 2,  "column_position": 1,  "category": "premium",  "status": "booked"    },
        { "id": "uuid", "seat_number": 3,  "column_position": 3,  "category": "premium",  "status": "held"      },
        { "id": "uuid", "seat_number": 6,  "column_position": 5,  "category": "premium",  "status": "available" }
      ],
      "F": [
        { "id": "uuid", "seat_number": 9,  "column_position": 8,  "category": "regular",  "status": "available" },
        { "id": "uuid", "seat_number": 10, "column_position": 9,  "category": "regular",  "status": "held_by_me" }
      ]
    },
    "balcony": {
      "A": [ ... ]
    }
  }
}
```

**Rendering each seat using `column_position`:**
- Place each seat at its `column_position` index within the row
- If two adjacent seat objects have a `column_position` gap > 1, render empty aisle cells to fill the gap
- Example: seat at col 1 then next at col 4 → render 2 empty spaces between them

**Seat color by status:**
| status | Color | Tappable |
|--------|-------|---------|
| `available` | Green (regular) / Blue (premium) / Gold (balcony) | Yes |
| `selected` (local state) | Blue highlight | Yes (deselect) |
| `held` | Yellow/orange | No |
| `held_by_me` | Blue outline | Yes (already selected) |
| `booked` | Dark grey | No |

**Selection rules:**
- Max selectable = total count from SeatCountScreen
- Only seats matching the user's chosen categories can be selected
  - e.g. if user picked 2 Regular + 1 Balcony → can only pick from regular rows + balcony section
- Bottom bar updates live: "X seats · BTN YYYY"

**Live updates:** Re-fetch every 10–15 seconds so seats taken by others turn yellow/grey automatically.

---

### Screen 5 — SeatHoldScreen *(Cinema only)*

**What happens right after tapping "Confirm Seats":**
- App immediately calls the hold API
- On success → **10-minute countdown timer** starts in the header
- Screen transitions to PaymentScreen with timer still running
- If user navigates back → call release hold API
- If timer hits 0:00 → call release hold, show toast, navigate back to SeatMapScreen

**Hold API:**
```
POST /events/api/screenings/:screeningId/seats/hold
Authorization: Bearer <token>

{ "seat_ids": ["uuid-1", "uuid-2", "uuid-3"] }
```

**Success:**
```json
{
  "success": true,
  "data": {
    "held_seats": ["uuid-1", "uuid-2", "uuid-3"],
    "expires_at": "2026-05-10T07:43:00.000Z",
    "expires_in_seconds": 600
  }
}
```

**Error 409 — seat just taken by someone else:**
```json
{ "success": false, "message": "One or more selected seats are already taken" }
```
→ Refresh seat map, highlight changed seats, let user pick again.

**Release hold (back / timer expiry / app background):**
```
DELETE /events/api/screenings/:screeningId/seats/hold
Authorization: Bearer <token>
```

---

### Screen 6 — QuantityScreen *(Concerts / Festivals / Workshops / Experiences)*

> Replaces Screens 3, 3b, 4, 5 for non-cinema events.

**What the user sees:**
```
Mountain Echo Music Festival
Changlimithang Stadium  ·  Sat, 17 May

──────────────────────────────
General       BTN 300   [ − ] 0 [ + ]    500 left
Silver        BTN 600   [ − ] 0 [ + ]    200 left
Gold          BTN 1200  [ − ] 0 [ + ]    50 left
──────────────────────────────
Total: 0 tickets  ·  BTN 0

        [ Proceed to Payment ]
```

**No API call** — data comes from `ticket_tiers[]` in the Screen 2 event detail response.

**Rules:**
- Max per tier = `ticket_tiers[n].available_seats`
- Minimum 1 ticket total to enable button

---

### Screen 7 — PaymentScreen

**What the user sees:**
```
Order Summary
─────────────────────────────
Cinema Premiere: The Thunder Valley
Hall I  ·  Fri 10 May  ·  13:30

Seat F9   Regular   BTN 200
Seat F10  Regular   BTN 200
─────────────────────────────
Total                BTN 400

Attendee Names
[  Karma Dorji  ]   Ticket 1
[  Pema Lhamo   ]   Ticket 2

Payment Method
( ) Wallet    ( ) Card    ( ) UPI

        [ Pay BTN 400 & Confirm ]
```

**Cinema booking — API body:**
```json
{
  "screening_id": "screening-uuid",
  "seat_ids": ["seat-uuid-1", "seat-uuid-2"],
  "attendee_names": ["Karma Dorji", "Pema Lhamo"],
  "payment_method": "WALLET"
}
```

**General admission — API body:**
```json
{
  "event_id": "event-uuid",
  "tier_id": "tier-uuid",
  "quantity": 2,
  "attendee_names": ["Karma Dorji", "Pema Lhamo"],
  "payment_method": "WALLET"
}
```

**Both call:**
```
POST /events/api/bookings
Authorization: Bearer <token>
```

**Cinema response (on success):**
```json
{
  "success": true,
  "data": {
    "booking_id": "BK-20260510-0042",
    "ticket_code": "TD-KA29BX17",
    "screening_id": "uuid",
    "screening_date": "2026-05-10",
    "screening_time": "13:30",
    "event_title": "Cinema Premiere: The Thunder Valley",
    "venue_name": "City Cinema Hall",
    "quantity": 2,
    "total_amount": 400,
    "payment_method": "WALLET",
    "attendee_names": ["Karma Dorji", "Pema Lhamo"],
    "seats": [
      { "row": "F", "number": 9,  "section": "main", "category": "regular", "price": 200 },
      { "row": "F", "number": 10, "section": "main", "category": "regular", "price": 200 }
    ],
    "created_at": "2026-05-10T05:32:00.000Z"
  }
}
```

---

### Screen 8 — BookingConfirmationScreen

**What the user sees:**
```
        ✅  Booking Confirmed!

   ┌─────────────────────────┐
   │  ▄▄▄▄▄ ▄   ▄ ▄▄▄▄▄     │
   │  █   █ ██ ██ █   █  QR  │
   │  █▄▄▄█ █▄▄▄█ █▄▄▄█     │
   └─────────────────────────┘
        Scan at entry gate

  Cinema Premiere: The Thunder Valley
  Hall I  ·  Fri 10 May 2026  ·  13:30
  City Cinema Hall, Norzin Lam

  Seats: F9, F10  (Regular)
  Booking ID: BK-20260510-0042
  Total Paid: BTN 400  ·  Wallet

  Karma Dorji  ·  Pema Lhamo

  [ View My Tickets ]    [ Go Home ]
```

**QR code:** Generate client-side using any QR library from `ticket_code` (e.g. `TD-KA29BX17`).

**No extra API call** — all data is in the `POST /bookings` response. Store it in navigation params / local state.

---

### Screen 9 — MyTicketsScreen

**What the user sees:**
- Tabs: **Upcoming** · **Past**
- Ticket cards:
  - Cover image thumbnail
  - Event title + category badge
  - Cinema: "Hall I · 13:30 · F9, F10"
  - Others: "Gold · 2 tickets"
  - Date · Venue
  - Status: green "Confirmed" or red "Cancelled"
  - Tap → expands to full ticket view with QR code

**API called on load:**
```
GET /events/api/bookings/me
Authorization: Bearer <token>
```

**Key response fields:**
| Field | Used for |
|-------|----------|
| `ticket_code` | QR code generation |
| `event_title` | Card title |
| `event_start_at` | Date/time, sorting Upcoming vs Past |
| `venue_name` | Location line |
| `seats[]` | Cinema: "F9, F10" label |
| `tier_name` + `quantity` | General admission label |
| `total_amount` | "BTN XXX paid" |
| `status` | Confirmed / Cancelled badge colour |
| `payment_method` | Payment info line |
| `attendee_names` | Names on ticket detail |

**Upcoming vs Past logic (frontend):**
```js
const now = new Date();
const upcoming = bookings.filter(b => new Date(b.event_start_at) > now && b.status === 'confirmed');
const past = bookings.filter(b => new Date(b.event_start_at) <= now || b.status === 'cancelled');
```

---

### Screen 10 — CancelTicketScreen

**What the user sees:**
```
Cancel Booking?

  The Thunder Valley  ·  F9, F10
  Hall I  ·  Fri 10 May  ·  13:30

  Refund: BTN 400
  Processing time: 3–5 business days

  [ Keep Booking ]   [ Yes, Cancel ]
```

**API called on confirm:**
```
DELETE /events/api/bookings/:bookingId
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "message": "Booking cancelled. Refund of BTN 400 will be processed within 3-5 business days."
}
```

→ Show the message as a toast, navigate back to MyTicketsScreen, update ticket status to "Cancelled".

---

### Screen 11 — ReviewsScreen

**What the user sees:**
```
Reviews & Ratings

  ★★★★☆  4.3  (128 reviews)

  [ ★ ★ ★ ★ ★ ]  ← tap to rate
  [ Write your review...      ]
  [ Submit ]

  ──────────────────────────
  Karma D.     ★★★★☆
  "Amazing cinematography and plot!"
  24 Apr 2026

  Pema L.      ★★★★★
  "Best movie this year!"
  23 Apr 2026
  ──────────────────────────
  [ Load more reviews ]
```

**Get reviews (on load, paginated):**
```
GET /events/api/events/:id/reviews?page=1&limit=10
```

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": "uuid", "rating": 4, "comment": "Amazing!", "user_name": "Karma D.", "created_at": "..." }
  ],
  "avg_rating": 4.3,
  "total": 128
}
```

**Submit review:**
```
POST /events/api/events/:id/reviews
Authorization: Bearer <token>

{ "rating": 4, "comment": "Amazing cinematography!" }
```

> Submitting again updates the existing review (upsert — one review per user per event).

---

## Full Booking Flows

### Cinema Flow (BookMyShow-style)
```
EventsHomeScreen
      ↓  tap movie card
EventDetailsScreen ─────────────── GET /events/:id
                                   GET /events/:id/reviews
                                   GET /wishlist
      ↓  tap "Book Tickets"
ScreeningPickerScreen ──────────── GET /events/:id/screenings?date=
      ↓  tap a showtime
SeatCountScreen ────────────────── (no API — uses ticket_tiers from Screen 2)
      ↓  set ticket count → "Select Seats"
SeatMapScreen ──────────────────── GET /screenings/:id/seats
      ↓  select seats → "Confirm Seats"
                      ────────────── POST /screenings/:id/seats/hold
                                     ← 10-minute timer starts
PaymentScreen
      ↓  fill attendee names + pick payment → "Pay & Confirm"
BookingConfirmationScreen ─────── POST /bookings { screening_id, seat_ids, ... }
      ↓  tap "View My Tickets"
MyTicketsScreen ────────────────── GET /bookings/me
```

### General Admission Flow (Concerts / Festivals / Workshops)
```
EventsHomeScreen
      ↓  tap event card
EventDetailsScreen ─────────────── GET /events/:id
                                   GET /events/:id/reviews
                                   GET /wishlist
      ↓  tap "Buy Tickets"
QuantityScreen ─────────────────── (no API — uses ticket_tiers from Screen 2)
      ↓  set quantities → "Proceed to Payment"
PaymentScreen
      ↓  fill attendee names + pick payment → "Pay & Confirm"
BookingConfirmationScreen ─────── POST /bookings { event_id, tier_id, quantity, ... }
      ↓  tap "View My Tickets"
MyTicketsScreen ────────────────── GET /bookings/me
```

---

## API Quick Reference

### Events
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/events` | No | List events with filters |
| GET | `/events/live` | No | Current live event |
| GET | `/events/:id` | No | Event detail + ticket_tiers |
| GET | `/events/:id/screenings?date=` | No | Showtimes grouped by hall |
| GET | `/events/:id/halls` | No | Halls for venue |
| GET | `/events/:id/reviews` | No | Reviews list |
| POST | `/events/:id/reviews` | Yes | Submit/update review |

### Screenings
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/screenings/:id` | No | Screening detail + available seats |
| GET | `/screenings/:id/seats` | Optional | Seat map with live status |
| POST | `/screenings/:id/seats/hold` | Yes | Hold seats (10 min) |
| DELETE | `/screenings/:id/seats/hold` | Yes | Release hold |

### Bookings
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/bookings` | Yes | Create booking (cinema or general) |
| GET | `/bookings/me` | Yes | My tickets |
| DELETE | `/bookings/:id` | Yes | Cancel booking |

### Wishlist & Auth
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/wishlist` | Yes | My wishlisted event IDs |
| POST | `/wishlist/toggle` | Yes | Add/remove from wishlist |
| POST | `/auth/register` | No | Register new user |
| POST | `/auth/login` | No | Login → returns JWT token |

---

## Hall IDs — City Cinema Hall

| Hall | ID | Seats |
|------|----|-------|
| Hall I Main | `hall-ci-h1m-0000-000000000002` | 209 |
| Hall I Balcony | `hall-ci-h1b-0000-000000000001` | 56 |
| Hall II Main | `hall-ci-h2m-0000-000000000004` | 223 |
| Hall II Balcony | `hall-ci-h2b-0000-000000000003` | 56 |

> Other venues (Changlimithang Stadium, Rinpung Dzong, etc.) have no seat map — they use the general admission flow only.

---

## Database Schema (Backend Reference)

### events
| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| title | VARCHAR | |
| category | ENUM | cinema, concert, festival, workshop, experience |
| city | VARCHAR | |
| venue_name | VARCHAR | |
| venue_address | VARCHAR | |
| organizer_name | VARCHAR | |
| organizer_id | UUID | FK → organizers |
| cover_image | VARCHAR | Relative path |
| description | TEXT | |
| start_at | TIMESTAMP | |
| end_at | TIMESTAMP | |
| is_live | BOOLEAN | Default false |
| avg_rating | DECIMAL | Computed |
| total_reviews | INT | Computed |

### ticket_tiers
| Field | Type | Notes |
|-------|------|-------|
| id | UUID | |
| event_id | UUID | FK → events |
| name | VARCHAR | Regular, VIP, etc. |
| description | VARCHAR | |
| price | INT | In Ngultrum |
| available_seats | INT | |

### bookings
| Field | Type | Notes |
|-------|------|-------|
| id | UUID | booking_id |
| ticket_code | VARCHAR | Unique, for QR |
| user_id | UUID | FK → users |
| event_id | UUID | FK → events |
| tier_id | UUID | FK → ticket_tiers |
| quantity | INT | |
| total_amount | INT | |
| payment_method | ENUM | WALLET, CARD, UPI |
| attendee_names | JSONB | Array of strings |
| status | ENUM | confirmed, cancelled |
| created_at | TIMESTAMP | |

### reviews
| Field | Type | Notes |
|-------|------|-------|
| id | UUID | |
| event_id | UUID | FK → events |
| user_id | UUID | FK → users |
| rating | INT | 1-5 |
| comment | TEXT | |
| created_at | TIMESTAMP | |

### wishlists
| Field | Type | Notes |
|-------|------|-------|
| user_id | UUID | FK → users |
| event_id | UUID | FK → events |
| created_at | TIMESTAMP | |
