document.getElementById("btnDMs").addEventListener("click", () => {
  const sb = document.getElementById("dmSidebar");
  sb.classList.toggle("open");
  if (window.updateDMListSidebar) updateDMListSidebar();
});
