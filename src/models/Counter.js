import mongoose from "mongoose";

// Monotonic sequences (e.g. ticket numbers). `$inc` with upsert is atomic,
// so two tickets created at once can't be handed the same number.
const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });

export const Counter = mongoose.model("Counter", counterSchema);

export async function nextSequence(name) {
  const doc = await Counter.findByIdAndUpdate(name, { $inc: { seq: 1 } }, { returnDocument: "after", upsert: true });
  return doc.seq;
}
