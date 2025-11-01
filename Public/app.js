const form = document.getElementById("generateForm");
const outputDiv = document.getElementById("output");

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const formData = new FormData(form);
  const prompt = formData.get("prompt");
  const subjectUrl = formData.get("subject"); // image URL
  const referenceUrl = formData.get("reference"); // image URL

  const subject = subjectUrl ? [{ url: subjectUrl, filename: "subject.png" }] : [];
  const References = referenceUrl ? [{ url: referenceUrl, filename: "reference.png" }] : [];

  outputDiv.innerHTML = "<p>Generating…</p>";

  try {
    const response = await fetch("/api/create-record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, subject, References })
    });

    const data = await response.json();
    outputDiv.innerHTML = `<p>${data.message}</p>`;

    // fetch all records
    const recordsResp = await fetch("/api/records");
    const recordsData = await recordsResp.json();

    outputDiv.innerHTML += "<h3>All Records:</h3>";
    recordsData.data.forEach(r => {
      const div = document.createElement("div");
      div.innerHTML = `<strong>ID:</strong> ${r.id}<br>
                       <strong>Prompt:</strong> ${r.fields.Prompt || ""}<br>
                       <strong>Status:</strong> ${r.fields.Status || ""}<br>`;
      outputDiv.appendChild(div);
    });

  } catch (err) {
    outputDiv.innerHTML = `<p style="color:red">Error: ${err.message}</p>`;
  }
});
