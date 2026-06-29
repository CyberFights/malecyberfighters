
document.addEventListener("DOMContentLoaded", () => {
  const gate = document.getElementById("ageGate");
  const gif = document.getElementById("introGif");
  const btn = document.getElementById("confirmBtn");

  if (!gate || !gif || !btn) return;

  btn.addEventListener("click", () => {
    gif.style.backgroundImage = "url('/images/intro.gif')";
    gif.style.opacity = "1";
    gate.style.opacity = "0";

    setTimeout(() => {
      gif.style.opacity = "0";   // fade GIF out
    }, 8000);

    setTimeout(() => {
      gate.style.display = "none";
      gif.style.display = "none";
    }, 8800);
  });
});
