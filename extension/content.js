(function () {
  if (document.getElementById("freenotez-btn")) return;

  const btn = document.createElement("button");
  btn.id = "freenotez-btn";
  btn.textContent = "📝 FreeNotez";

  btn.addEventListener("click", () => {
    alert("FreeNotez button clicked! Recording will start here soon.");
  });

  document.body.appendChild(btn);
})();
