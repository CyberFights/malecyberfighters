document.getElementById("btnDMs").addEventListener("click", () => {
  const panel = document.getElementById("dmSidebar");
  const chat = document.getElementById("chatPopup");

  panel.classList.toggle("open");
  chat.classList.toggle("shifted");
});
document.getElementById("btnRooms").addEventListener("click", () => {
  const panel = document.getElementById("roomsSidebar");
  panel.classList.toggle("open");
});
$('closeDmSidebar')?.addEventListener('click', () => {
  $('dmSidebar').classList.remove('open');
});

$('closeRoomsSidebar')?.addEventListener('click', () => {
  $('roomsSidebar').classList.remove('open');
});
