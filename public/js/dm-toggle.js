function openListPopup(id) {
  const panel = document.getElementById(id);
  if (!panel) return;
  panel.style.display = "flex";
}

function closeListPopup(id) {
  const panel = document.getElementById(id);
  if (!panel) return;
  panel.style.display = "none";
}

document.getElementById("btnDMs")?.addEventListener("click", () => {
  openListPopup("dmSidebar");
  if (window.updateDMListSidebar) window.updateDMListSidebar();
  if (window.updateDMBadge) window.updateDMBadge();
});

document.getElementById("btnRooms")?.addEventListener("click", () => {
  openListPopup("roomsSidebar");
  if (typeof renderRoomsSidebar === "function") renderRoomsSidebar();
});

document.getElementById("closeDmSidebar")?.addEventListener("click", () => {
  closeListPopup("dmSidebar");
});

document.getElementById("closeRoomsSidebar")?.addEventListener("click", () => {
  closeListPopup("roomsSidebar");
});

["dmSidebar", "roomsSidebar"].forEach(id => {
  document.getElementById(id)?.addEventListener("click", e => {
    if (e.target === e.currentTarget) closeListPopup(id);
  });
});

document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  closeListPopup("dmSidebar");
  closeListPopup("roomsSidebar");
});
