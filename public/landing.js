document.getElementById("confirmBtn").addEventListener("click", () => {
  const gate = document.getElementById("ageGate");
  const gif = document.getElementById("introGif");

  // WebP first, GIF for browsers without animated WebP. Injected on click so
  // the animation is never downloaded by someone who does not confirm.
  gif.innerHTML =
    '<picture>' +
      '<source srcset="/images/intro.webp" type="image/webp">' +
      '<img src="/images/intro.gif" alt="" width="426" height="240">' +
    '</picture>';

  gif.style.opacity = "1";      // fade GIF in
  gate.style.opacity = "0";     // fade overlay out

  setTimeout(() => {
    window.location.href = "/index.html"; // your main chat page
  }, 9000);
});
