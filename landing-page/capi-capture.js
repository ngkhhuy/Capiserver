/**
 * capi-capture.js
 * Landing Page helper — gọi /capture trên CAPI Server khi user submit form.
 *
 * Cách tích hợp vào js/main.js:
 *   1. Copy toàn bộ file này vào đầu js/main.js (hoặc include riêng trước main.js).
 *   2. Thay SERVER_KEY_PLACEHOLDER bằng server key thật.
 *   3. Thay CAPI_ENDPOINT bằng domain CAPI server của bạn.
 *   4. Trong submit handler, gọi captureLeadToCapi() ngay trước location.href redirect.
 *
 * Ví dụ trong submit handler:
 *   $("#apply_form").on("submit", function(e) {
 *     e.preventDefault();
 *     // ... validate ...
 *     captureLeadToCapi();          // <-- thêm dòng này
 *     location.href = finalUrl.toString();
 *   });
 */

(function () {
  "use strict";

  // -----------------------------------------------------------------------
  // Config — sửa hai giá trị này
  // -----------------------------------------------------------------------
  var CAPI_SERVER_KEY = "SERVER_KEY_PLACEHOLDER";
  var CAPI_ENDPOINT   = "https://api.lendoraai.site/capture";

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------
  function getQueryParam(name) {
    return new URLSearchParams(window.location.search).get(name) || "";
  }

  function getFirstNonEmpty(values) {
    for (var i = 0; i < values.length; i++) {
      if (values[i]) return values[i];
    }
    return "";
  }

  function getCookie(name) {
    var match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
    return match ? decodeURIComponent(match[2]) : "";
  }

  /**
   * Lấy vl_clickid theo thứ tự ưu tiên:
   * URL params → localStorage (đã lưu từ lần trước)
   */
  function getVlClickId() {
    var id = getFirstNonEmpty([
      getQueryParam("vl_clickid"),
      getQueryParam("click_id"),
      getQueryParam("clickid"),
      getQueryParam("cid"),
      getQueryParam("subid"),
    ]);

    if (id) {
      try { localStorage.setItem("vl_clickid", id); } catch (e) {}
      return id;
    }

    try { return localStorage.getItem("vl_clickid") || ""; } catch (e) { return ""; }
  }

  function getTtclid() {
    return getQueryParam("ttclid");
  }

  function getTtp() {
    return getCookie("_ttp") || getCookie("ttp") || "";
  }

  // -----------------------------------------------------------------------
  // Main capture function — gọi trước redirect
  // -----------------------------------------------------------------------
  window.captureLeadToCapi = function () {
    var vlClickId = getVlClickId();

    if (!vlClickId) {
      console.warn("[CAPI] capture skipped: missing vl_clickid");
      return;
    }

    var payload = {
      server_key: CAPI_SERVER_KEY,
      vl_clickid: vlClickId,
      ttclid:     getTtclid(),
      ttp:        getTtp(),
      url:        window.location.href,
      referrer:   document.referrer || "",
      user_agent: navigator.userAgent,
    };

    // Email từ form
    var email = ($("#email_add").val() || "").trim();
    if (email) payload.email = email;

    // Phone (nếu sau này thêm field phone vào form)
    // var phone = ($("#phone").val() || "").trim();
    // if (phone) payload.phone = phone;

    // Bỏ các field rỗng/null để tránh gửi giá trị không cần thiết
    Object.keys(payload).forEach(function (key) {
      if (payload[key] === "" || payload[key] == null) delete payload[key];
    });

    try {
      // keepalive: true đảm bảo request hoàn tất dù page redirect ngay sau
      fetch(CAPI_ENDPOINT, {
        method:    "POST",
        headers:   { "Content-Type": "application/json" },
        body:      JSON.stringify(payload),
        keepalive: true,
      }).catch(function (err) {
        console.warn("[CAPI] capture failed:", err);
      });
    } catch (err) {
      console.warn("[CAPI] capture error:", err);
    }
  };
})();
