function money(value) {
  return `¥${Number(value || 0).toFixed(0)}`;
}

function time(value) {
  if (!value) {
    return "--:--:--";
  }

  const date = new Date(value);
  const pad = (input) => String(input).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function remaining(endTime, serverOffset = 0) {
  if (!endTime) {
    return "00:00";
  }

  const ms = Math.max(0, endTime - (Date.now() + serverOffset));
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

module.exports = {
  money,
  remaining,
  time
};
