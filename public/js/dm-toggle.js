document.getElementById("btnDMs").addEventListener("click", () => {
  const panel = document.getElementById("dmSidebar");
  panel.style.display = "flex";
});

document.getElementById("btnRooms").addEventListener("click", () => {
  const panel = document.getElementById("roomsSidebar");
  panel.style.display = "flex";
});

document.getElementById("closeDmSidebar")?.addEventListener("click", () => {
  document.getElementById("dmSidebar").style.display = "none";
});

document.getElementById("closeRoomsSidebar")?.addEventListener("click", () => {
  document.getElementById("roomsSidebar").style.display = "none";
});
