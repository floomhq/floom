import { describe, expect, it } from "vitest";
import {
  ACTION_BUCKETS,
  bucketForAction,
  groupActions,
} from "@/lib/connections/action-buckets";

describe("bucketForAction (#1671) — plain-language action grouping", () => {
  it("classifies read/fetch verbs as 'read'", () => {
    expect(bucketForAction("Fetch message by message ID")).toBe("read");
    expect(bucketForAction("Get People")).toBe("read");
    expect(bucketForAction("List drafts")).toBe("read");
    expect(bucketForAction("Search emails")).toBe("read");
    expect(bucketForAction("Read message")).toBe("read");
  });

  it("classifies send/create verbs as 'send'", () => {
    expect(bucketForAction("Create email draft")).toBe("send");
    expect(bucketForAction("Send email")).toBe("send");
    expect(bucketForAction("Reply to thread")).toBe("send");
    expect(bucketForAction("Add label")).toBe("send");
    expect(bucketForAction("Modify email labels")).toBe("send");
  });

  it("classifies organize verbs as 'organize'", () => {
    expect(bucketForAction("Label message")).toBe("organize");
    expect(bucketForAction("Move to folder")).toBe("organize");
    expect(bucketForAction("Archive thread")).toBe("organize");
    expect(bucketForAction("Mark as read")).toBe("organize");
  });

  it("classifies delete/remove verbs as 'manage'", () => {
    expect(bucketForAction("Delete Draft")).toBe("manage");
    expect(bucketForAction("Remove label")).toBe("manage");
    expect(bucketForAction("Trash message")).toBe("manage");
  });

  it("strips a leading app prefix and matches the inner verb", () => {
    expect(bucketForAction("GMAIL_FETCH_MESSAGE")).toBe("read");
    expect(bucketForAction("GMAIL_SEND_EMAIL")).toBe("send");
    expect(bucketForAction("SLACK_DELETE_MESSAGE")).toBe("manage");
  });

  it("handles camelCase ids", () => {
    expect(bucketForAction("fetchMessageById")).toBe("read");
    expect(bucketForAction("createDraft")).toBe("send");
  });

  it("falls back to 'other' for unrecognized verbs", () => {
    expect(bucketForAction("Reconcile ledger")).toBe("other");
    expect(bucketForAction("Foobar")).toBe("other");
    expect(bucketForAction("")).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(bucketForAction("GET PEOPLE")).toBe("read");
    expect(bucketForAction("get people")).toBe("read");
  });
});

describe("groupActions (#1671)", () => {
  const items = [
    { name: "Get People", description: "" },
    { name: "Fetch message by message ID", description: "" },
    { name: "Send email", description: "" },
    { name: "Create email draft", description: "" },
    { name: "Label message", description: "" },
    { name: "Delete Draft", description: "" },
    { name: "Reconcile ledger", description: "" },
  ];

  it("groups into ordered, non-empty buckets", () => {
    const groups = groupActions(items, (t) => t.name);
    const keys = groups.map((g) => g.def.key);
    // Render order follows ACTION_BUCKETS order, empties dropped.
    expect(keys).toEqual(["read", "send", "organize", "manage", "other"]);
  });

  it("places each item in the right bucket", () => {
    const groups = groupActions(items, (t) => t.name);
    const byKey = Object.fromEntries(groups.map((g) => [g.def.key, g.items.map((i) => i.name)]));
    expect(byKey.read).toEqual(["Get People", "Fetch message by message ID"]);
    expect(byKey.send).toEqual(["Send email", "Create email draft"]);
    expect(byKey.organize).toEqual(["Label message"]);
    expect(byKey.manage).toEqual(["Delete Draft"]);
    expect(byKey.other).toEqual(["Reconcile ledger"]);
  });

  it("drops empty buckets", () => {
    const groups = groupActions(
      [{ name: "Get thing", description: "" }],
      (t) => t.name
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].def.key).toBe("read");
  });

  it("does not mutate the input list", () => {
    const input = [...items];
    groupActions(input, (t) => t.name);
    expect(input).toEqual(items);
  });

  it("every defined bucket has a label and blurb", () => {
    for (const def of ACTION_BUCKETS) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.blurb.length).toBeGreaterThan(0);
    }
  });
});
