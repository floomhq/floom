import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Orphan cleanup: mark runs stuck in "running" >10 minutes as sandbox_error.
crons.interval("cleanup stalled runs", { minutes: 5 }, internal.runs.cleanupStalledRuns, {});

export default crons;
