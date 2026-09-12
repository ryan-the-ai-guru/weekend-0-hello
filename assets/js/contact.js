/**
 * Contact form — posts to the serverless contact API.
 *
 * The endpoint is read from window.KFO_CONTACT_API (set inline in contact.html
 * to the CloudFormation `ContactApiEndpoint` output). If it is not configured,
 * the form degrades to opening a pre-filled mailto: draft rather than failing.
 */
(function () {
  "use strict";

  var form = document.getElementById("contact-form");
  if (!form) return;

  var statusEl = document.getElementById("form-status");
  var submitBtn = document.getElementById("submit");
  var messageEl = document.getElementById("message");
  var countEl = document.getElementById("message-count");
  var topicEl = document.getElementById("topic");
  var endpoint = (window.KFO_CONTACT_API || "").replace(/\/+$/, "");
  var officeEmail = window.KFO_CONTACT_EMAIL || "office@kroonenburg.capital";

  var TOPIC_LABELS = {
    general: "General enquiry",
    "executive-assistant": "Executive Assistant",
    cfo: "Chief Financial Officer",
    "chief-counsel": "Chief Counsel",
  };

  // Preselect the recipient when arriving from a team page (?to=cfo).
  var requested = new URLSearchParams(window.location.search).get("to");
  if (requested && topicEl && TOPIC_LABELS[requested]) {
    topicEl.value = requested;
  }

  // Live character count.
  if (messageEl && countEl) {
    var updateCount = function () {
      countEl.textContent = String(messageEl.value.length);
    };
    messageEl.addEventListener("input", updateCount);
    updateCount();
  }

  function setStatus(kind, text) {
    if (!statusEl) return;
    statusEl.className = "form-status " + kind;
    statusEl.textContent = text;
    statusEl.hidden = false;
  }

  function clearStatus() {
    if (statusEl) statusEl.hidden = true;
  }

  function setFieldError(id, text) {
    var input = document.getElementById(id);
    var error = document.getElementById(id + "-error");
    if (input) input.setAttribute("aria-invalid", text ? "true" : "false");
    if (error) {
      error.textContent = text || "";
      error.hidden = !text;
    }
  }

  function validate(values) {
    var errors = {};
    if (!values.name) {
      errors.name = "Please tell us your name.";
    }
    if (!values.email) {
      errors.email = "Please give us an email address to reply to.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email)) {
      errors.email = "That does not look like a valid email address.";
    }
    if (!values.message) {
      errors.message = "Please include a message.";
    } else if (values.message.length < 10) {
      errors.message = "Please add a little more detail (10 characters minimum).";
    }
    return errors;
  }

  function readValues() {
    var data = new FormData(form);
    var get = function (key) {
      return String(data.get(key) || "").trim();
    };
    return {
      name: get("name"),
      email: get("email"),
      organisation: get("organisation"),
      topic: get("topic") || "general",
      message: get("message"),
      company_website: get("company_website"), // honeypot
    };
  }

  function mailtoFallback(values) {
    var subject =
      "Website enquiry — " + (TOPIC_LABELS[values.topic] || "General enquiry");
    var body = [
      "Name: " + values.name,
      "Email: " + values.email,
      values.organisation ? "Organisation: " + values.organisation : null,
      "For: " + (TOPIC_LABELS[values.topic] || "General enquiry"),
      "",
      values.message,
    ]
      .filter(Boolean)
      .join("\n");

    window.location.href =
      "mailto:" +
      officeEmail +
      "?subject=" +
      encodeURIComponent(subject) +
      "&body=" +
      encodeURIComponent(body);

    setStatus(
      "ok",
      "Opening your email client with the message ready to send. If nothing " +
        "happens, write to " + officeEmail + " directly."
    );
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    clearStatus();

    var values = readValues();
    ["name", "email", "message"].forEach(function (id) {
      setFieldError(id, "");
    });

    var errors = validate(values);
    var firstBad = Object.keys(errors)[0];
    if (firstBad) {
      Object.keys(errors).forEach(function (id) {
        setFieldError(id, errors[id]);
      });
      var el = document.getElementById(firstBad);
      if (el) el.focus();
      setStatus("err", "Please correct the highlighted fields.");
      return;
    }

    // Bot filled the honeypot — accept silently, send nothing.
    if (values.company_website) {
      form.reset();
      setStatus("ok", "Thank you — your message has been received.");
      return;
    }

    if (!endpoint) {
      mailtoFallback(values);
      return;
    }

    submitBtn.disabled = true;
    var originalLabel = submitBtn.textContent;
    submitBtn.textContent = "Sending…";

    fetch(endpoint + "/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return {};
          })
          .then(function (payload) {
            return { ok: response.ok, status: response.status, payload: payload };
          });
      })
      .then(function (result) {
        if (result.ok) {
          form.reset();
          if (countEl) countEl.textContent = "0";
          setStatus(
            "ok",
            "Thank you — your message has reached the office. You will hear " +
              "back on the next working day at the latest."
          );
          return;
        }
        if (result.status === 429) {
          setStatus(
            "err",
            "That is a few messages in quick succession. Please try again in a " +
              "moment."
          );
          return;
        }
        setStatus(
          "err",
          (result.payload && result.payload.message) ||
            "Your message could not be sent. Please email " + officeEmail + "."
        );
      })
      .catch(function () {
        setStatus(
          "err",
          "Your message could not be sent — the office may be offline. Please " +
            "email " + officeEmail + " instead."
        );
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      });
  });

  // Keep the sidebar email link in step with the configured address.
  var emailLink = document.getElementById("office-email");
  if (emailLink) {
    emailLink.href = "mailto:" + officeEmail;
    emailLink.textContent = officeEmail;
  }
})();
