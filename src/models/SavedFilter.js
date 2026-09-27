import mongoose from "mongoose";
import { withIdJSON } from "./plugins.js";

/** A named issue search. `query` holds the same params as GET /issues. */
const savedFilterSchema = new mongoose.Schema(
  {
    ownerId: { type: String, required: true, ref: "Employee" },
    name: { type: String, required: true },
    query: { type: Object, default: {} },
    shared: { type: Boolean, default: false },
  },
  { timestamps: true },
);

withIdJSON(savedFilterSchema);

export const SavedFilter = mongoose.model("SavedFilter", savedFilterSchema);
