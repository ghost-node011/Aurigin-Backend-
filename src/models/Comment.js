import mongoose from "mongoose";
import { withIdJSON } from "./plugins.js";
import { attachmentSchema } from "./Issue.js";

/**
 * A comment on an issue. Mentions are written in the body as
 * `@[Name](employee-id)`; their ids are stored in `mentionIds` too, and
 * mentioned people start watching the issue.
 */
const commentSchema = new mongoose.Schema(
  {
    issueId: { type: mongoose.Schema.Types.ObjectId, ref: "Issue", required: true },
    authorId: { type: String, required: true, ref: "Employee" },
    body: { type: String, required: true },
    mentionIds: { type: [String], default: [] },
    attachments: { type: [attachmentSchema], default: [] },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

commentSchema.index({ issueId: 1, createdAt: 1 });

withIdJSON(commentSchema);

export const Comment = mongoose.model("Comment", commentSchema);
