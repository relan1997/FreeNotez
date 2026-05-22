(function () {
  // Don't inject on the landing/home page
  if (window.location.pathname === "/landing" || window.location.pathname === "/") return;

  function injectButton() {
    if (document.getElementById("freenotez-btn")) return;

    const btn = document.createElement("button");
    btn.id = "freenotez-btn";

    const img = document.createElement("img");
    img.src = chrome.runtime.getURL("media/icon1.jpeg");
    img.alt = "FreeNotez";
    btn.appendChild(img);

    btn.addEventListener("click", () => {
      alert("FreeNotez button clicked! Recording will start here soon.");
    });

    document.body.appendChild(btn);
  }

  // Wait for the meeting to actually load (Meet uses SPA navigation)
  // The meeting is joined when a meeting code path like /abc-defg-hij is present
  const meetingCodePattern = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
  if (meetingCodePattern.test(window.location.pathname)) {
    injectButton();
  }

  // Also observe URL changes (Meet is a SPA)
  let lastPath = window.location.pathname;
  const observer = new MutationObserver(() => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      if (meetingCodePattern.test(lastPath)) {
        injectButton();
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();
