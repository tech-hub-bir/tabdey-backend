// src/matching/redisKeys.js (ESM)
export const geoKey    = (cityId, serviceCode) => `geo:drivers:city:${cityId}:${serviceCode}`;
export const onlineSet = (cityId, serviceCode) => `online:drivers:city:${cityId}:${serviceCode}`;
export const driverHash = (driverId) => `drivers:${driverId}`;

export const rideHash     = (rideId) => `ride:${rideId}`;
export const rideCand     = (rideId) => `ride:${rideId}:candidates`;
export const rideCurrent  = (rideId) => `ride:${rideId}:current`;
export const rideRejected = (rideId) => `ride:${rideId}:rejected`;

export const currentRidesKey = (driverId) => `driver:current:rides:${driverId}`;
export const currentPassengerRideKey = (passengerId) => `passenger:current:ride:${passengerId}`;

