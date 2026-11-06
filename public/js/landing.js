
document.addEventListener("DOMContentLoaded", () => {
  const gate = document.getElementById("ageGate");
  const gif = document.getElementById("introGif");
  const btn = document.getElementById("confirmBtn");

  if (!gate || !gif || !btn) return;

  // The promotional landing page at / is the primary age gate. Its confirmed
  // entry hands off here so visitors do not have to answer the same question
  // twice. Direct /arena visits (or blocked storage) keep the original gate.
  let ageConfirmed = false;
  try { ageConfirmed = window.sessionStorage.getItem('mcfAgeConfirmed') === 'true'; } catch (_) {}
  if (ageConfirmed) {
    gate.style.display = "none";
    gif.style.display = "none";
    return;
  }

  btn.addEventListener("click", () => {
    // WebP first, GIF for browsers without animated WebP. Injected on click
    // rather than written into the markup so the animation is never downloaded
    // by a visitor who does not confirm their age.
    gif.innerHTML =
      '<picture>' +
        '<source srcset="/images/intro.webp" type="image/webp">' +
        '<img src="/images/intro.gif" alt="" width="426" height="240">' +
      '</picture>';
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
