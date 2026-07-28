document.getElementById("btnDMs")?.addEventListener("click", () => {
  const panel = document.getElementById("dmSidebar");
  if (!panel) return;
  panel.style.display = "flex";
  if (window.updateDMListSidebar) window.updateDMListSidebar();
  if (window.updateDMBadge) window.updateDMBadge();
});

document.getElementById("btnRooms")?.addEventListener("click", () => {
  const panel = document.getElementById("roomsSidebar");
  if (!panel) return;
  panel.style.display = "flex";
  if (typeof renderRoomsSidebar === "function") renderRoomsSidebar();
});

document.getElementById("closeDmSidebar")?.addEventListener("click", () => {
  const panel = document.getElementById("dmSidebar");
  if (panel) panel.style.display = "none";
});

document.getElementById("closeRoomsSidebar")?.addEventListener("click", () => {
  const panel = document.getElementById("roomsSidebar");
  if (panel) panel.style.display = "none";
});
