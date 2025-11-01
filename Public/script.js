// script.js

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("generateForm");
  const output = document.getElementById("outputMessage");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // Get values from form
    const prompt = document.getElementById("prompt").value;
    const subject = document.getElementById("subject").value;
    const references = document.getElementById("references").value;
    const width = document.getElementById("width").value;
    const height = document.getElementById("height").value;
    const batchCount = document.getElementById("batchCount").value;

    // Validate required fields
    if (!prompt || !subject) {
      output.textContent = "❌ Prompt and Subject URL are required!";
      output.style.color = "red";
      return;
    }

    // Prepare payload
    const payload = {
      prompt,
      subject,
      references: references ? references.split(",").map(url => url.trim()) : [],
      width,
      height,
      batchCount,
    };

    try {
      const response = await fetch("/api/generate-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      console.log("Server response:", data);

      output.textContent = data.message;
      output.style.color = "green";
    } catch (err) {
      console.error(err);
      output.textContent = "❌ Failed to send request";
      output.style.color = "red";
    }
  });
});
