# TabDey Driver Backend (Node.js + MySQL + MongoDB)

This is a minimal backend to power your Grab-style driver app:
- **MySQL** stores rides & earnings
- **MongoDB** stores driver online sessions/presence
- **Socket.IO** for live events
- **Express** REST for idempotent ride actions and earnings API

## 1) Requirements
- Node 18+
- MySQL 8+
- MongoDB 6+

## 2) Install
```bash
cp .env.example .env
# edit .env to your DB credentials
npm install
```

## 3) Prepare MySQL schema
```bash
# Login to MySQL and run:
# CREATE DATABASE grablike CHARACTER SET utf8mb4;
# USE grablike;
# Then execute the SQL:
mysql -u root -p grablike < sql/schema.sql
```

The schema seeds one driver and 2 completed rides.

## 4) Run MongoDB
Make sure MongoDB is running locally (or update MONGO_URI in `.env`).

## 5) Start the server
```bash
npm run dev
# or
npm start
```
Server runs on `http://localhost:4000` by default.

## 6) Test endpoints

### Health
```
GET http://localhost:4000/api/health
```

### Earnings
```
GET http://localhost:4000/api/driver/earnings?period=week&start=2025-08-01&end=2025-08-07&driver_id=1
```

### Ride flow (idempotent)
```
POST http://localhost:4000/api/driver/ride/1/accept
{ "driver_id": 1 }

POST http://localhost:4000/api/driver/ride/1/arrived
POST http://localhost:4000/api/driver/ride/1/start
POST http://localhost:4000/api/driver/ride/1/complete
```

## 7) Sockets
Connect your app to `ws://localhost:4000` and emit:
- `driverLocationUpdate` → broadcast to others
- `jobAccept`, `jobReject`, `driverArrivedPickup`, `driverStartTrip`, `driverCompleteTrip`

Server replies with simple acks and a dummy `fareFinalized` payload.

## Notes
- Money amounts are integer cents in MySQL; the API returns floating Nu for convenience.
- Production: add authentication, validation, and proper error handling.
- You can replace the dummy fare in `src/utils/fare.js` with real tariff logic.
