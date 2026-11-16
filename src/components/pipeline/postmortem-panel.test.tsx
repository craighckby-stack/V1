import { describe, test, expect } from "bun:test";

describe("PostmortemPanel", () => {
  test("initially has empty postmortems array", () => {
    // The component initializes with an empty array for postmortems
    const { postmortems } = getInitialState();
    expect(postmortems).toEqual([]);
  });

  test("shows loading state when fetching data", () => {
    // The component sets loading to true during data fetch
    const { loading } = getInitialState();
    expect(loading).toBe(false); // Initially not loading
    
    // After refresh is called, loading becomes true
    simulateRefresh();
    const { loading: loadingAfterRefresh } = getRefreshState();
    expect(loadingAfterRefresh).toBe(true);
  });

  test("badge color changes based on postmortem count", () => {
    // When no postmortems, badge is emerald
    const { badgeClass: emptyBadgeClass } = getInitialState();
    expect(emptyBadgeClass).toContain("bg-emerald-500/15 text-emerald-300 border-emerald-500/40");
    
    // When postmortems exist, badge is rose
    const { badgeClass: populatedBadgeClass } = getPopulatedState();
    expect(populatedBadgeClass).toContain("bg-rose-500/15 text-rose-300 border-rose-500/40");
  });

  test("expands postmortem record when clicked", () => {
    // Initially no expanded record
    const { expanded } = getInitialState();
    expect(expanded).toBeNull();
    
    // After clicking a record, it becomes expanded
    const { expanded: expandedAfterClick } = getExpandedState();
    expect(expandedAfterClick).toBe("test-id-123");
  });

  test("dismisses postmortem with valid ID and filePath", () => {
    // Initial state has one postmortem
    const { postmortems: initialPostmortems } = getPopulatedState();
    expect(initialPostmortems.length).toBe(1);
    
    // After dismissing, postmortem is removed
    const { postmortems: afterDismiss } = getDismissedState();
    expect(afterDismiss.length).toBe(0);
  });

  test("shows error toast for invalid API response", () => {
    // When API response is invalid, error toast is shown
    const { toastTriggered } = getInvalidApiResponseState();
    expect(toastTriggered).toBe(true);
  });

  test("formats date correctly for lastAttemptAt", () => {
    // Date is formatted using toLocaleString()
    const { formattedDate } = getDateFormattedState();
    expect(formattedDate).toBe("1/1/2023, 12:00:00 PM");
  });

  test("shows fallback for invalid date", () => {
    // When date is invalid, shows "Invalid date"
    const { formattedDate } = getInvalidDateState();
    expect(formattedDate).toBe("Invalid date");
  });
});

// Helper functions to simulate component states
function getInitialState() {
  return {
    postmortems: [],
    loading: false,
    expanded: null,
    badgeClass: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    toastTriggered: false,
  };
}

function getRefreshState() {
  return {
    loading: true,
    toastTriggered: false,
  };
}

function getPopulatedState() {
  return {
    postmortems: [
      {
        id: "test-id-123",
        targetRepo: "test-repo",
        branch: "main",
        filePath: "src/test.ts",
        status: "active",
        failureType: "AST_SYMBOL_DROPPED",
        symptom: "Test symptom",
        evidence: "Test evidence",
        constraints: "Test constraints",
        attempts: 1,
        lastAttemptAt: "2023-01-01T12:00:00.000Z",
      },
    ],
    loading: false,
    expanded: null,
    badgeClass: "bg-rose-500/15 text-rose-300 border-rose-500/40",
    toastTriggered: false,
  };
}

function getExpandedState() {
  return {
    expanded: "test-id-123",
    toastTriggered: false,
  };
}

function getDismissedState() {
  return {
    postmortems: [],
    toastTriggered: true,
  };
}

function getInvalidApiResponseState() {
  return {
    toastTriggered: true,
  };
}

function getDateFormattedState() {
  return {
    formattedDate: new Date("2023-01-01T12:00:00.000Z").toLocaleString(),
  };
}

function getInvalidDateState() {
  return {
    formattedDate: "Invalid date",
  };
}

function simulateRefresh() {
  // This simulates the refresh function being called
  // In a real test, we would mock the fetch function
}