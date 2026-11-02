// Clicking the toolbar icon opens the side panel.
// The side panel stays open while you click around the page or switch tabs;
// it only closes when you press the X in its header.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(err));
