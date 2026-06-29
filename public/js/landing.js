document.addEventListener("DOMContentLoaded", () => {
  const gate = document.getElementById("ageGate");
  const gif = document.getElementById("introGif");
  const btn = document.getElementById("confirmBtn");

  btn.addEventListener("click", () => {
    gif.style.backgroundImage = "url('/images/intro.gif')";
    gif.style.opacity = "1";
    gate.style.opacity = "0";

    setTimeout(() => {
      gate.style.display = "none";
    }, 8800);
  });
});
