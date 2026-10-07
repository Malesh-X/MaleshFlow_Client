import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskSchedulePanel } from "../components/TaskSchedulePanel";
import { dateInputValueToTimestamp } from "../lib/domain/recurrence";

test("task schedule panel saves an optional time with the local time zone", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true },
    document: { value: dom.window.document, configurable: true },
    navigator: { value: dom.window.navigator, configurable: true },
    HTMLElement: { value: dom.window.HTMLElement, configurable: true },
    Event: { value: dom.window.Event, configurable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true, writable: true },
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { value: () => undefined, configurable: true },
    detachEvent: { value: () => undefined, configurable: true },
  });

  const saves: Array<{ dueTime: string | null; dueTimeZone: string | null }> = [];
  try {
    const user = userEvent.setup({ document: dom.window.document });
    const screen = render(
      <TaskSchedulePanel
        taskTitle="Pay bill"
        dueAt={dateInputValueToTimestamp("2026-08-20")}
        dueEndAt={null}
        dueTime={null}
        dueTimeZone={null}
        recurrenceFrequency={null}
        recurringCompletionMode="dueDate"
        onRecurringCompletionModeChange={() => undefined}
        onSave={async (args) => {
          saves.push(args);
        }}
        onSaved={() => undefined}
      />,
    );

    const timeInput = screen.getByLabelText("Time (optional)") as HTMLInputElement;
    assert.equal(timeInput.disabled, false);
    await user.type(timeInput, "14:45");
    assert.equal(timeInput.value, "14:45");
    await waitFor(() => assert.match(screen.container.textContent ?? "", /14:45/));
    await user.click(screen.getByRole("button", { name: "Save Schedule" }));
    await waitFor(() => assert.equal(saves.length, 1));
    assert.equal(saves[0]?.dueTime, "14:45");
    assert.equal(saves[0]?.dueTimeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);

  } finally {
    cleanup();
    dom.window.close();
  }
});
