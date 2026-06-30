// src/sockets/calls.js
// Relays call signalling through the existing ride room.
// No media flows through here — Agora handles that directly peer-to-peer.

const rideRoom = (rideId) => `ride:${rideId}`;

export function initCallEvents(io, socket) {
  // Initiator (passenger) → notify everyone else in the ride room
  socket.on("call:initiate", (payload = {}) => {
    const { requestId, channelName, callType, fromName, fromImage } = payload;
    if (!requestId || !channelName) return;
    console.log(`[call] initiate  ride:${requestId}  type:${callType || "voice"}`);
    socket.to(rideRoom(String(requestId))).emit("call:incoming", {
      requestId,
      channelName,
      callType: callType || "voice",
      fromName: fromName || "Passenger",
      fromImage: fromImage || null,
    });
  });

  // Receiver (driver) accepted
  socket.on("call:accept", (payload = {}) => {
    const { requestId } = payload;
    if (!requestId) return;
    console.log(`[call] accept    ride:${requestId}`);
    socket.to(rideRoom(String(requestId))).emit("call:accepted", { requestId });
  });

  // Receiver (driver) rejected
  socket.on("call:reject", (payload = {}) => {
    const { requestId } = payload;
    if (!requestId) return;
    console.log(`[call] reject    ride:${requestId}`);
    socket.to(rideRoom(String(requestId))).emit("call:rejected", { requestId });
  });

  // Either side ends — broadcast to all in room including sender
  socket.on("call:end", (payload = {}) => {
    const { requestId } = payload;
    if (!requestId) return;
    console.log(`[call] end       ride:${requestId}`);
    io.to(rideRoom(String(requestId))).emit("call:ended", { requestId });
  });
}
