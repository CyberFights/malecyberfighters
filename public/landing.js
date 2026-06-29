document.getElementById("confirmBtn").addEventListener("click", () => {
  const gate = document.getElementById("ageGate");
  const gif = document.getElementById("introGif");

  // Set your GIF here
  gif.style.backgroundImage = "url('/images/intro.gif')";

  gif.style.opacity = "1";      // fade GIF in
  gate.style.opacity = "0";     // fade overlay out

  setTimeout(() => {
    window.location.href = "/index.html"; // your main chat page
  }, 9000);
});
