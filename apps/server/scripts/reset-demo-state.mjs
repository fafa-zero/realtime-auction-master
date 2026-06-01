import { resetDemoState } from "../dist/store.js";

const result = resetDemoState();
const rooms = result.rooms.map((room) => `${room.id}:${room.title}`).join(", ");

console.log(`demo reset ok: ${rooms}`);
