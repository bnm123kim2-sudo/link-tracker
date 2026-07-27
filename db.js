// 아주 단순한 JSON 파일 기반 저장소.
// 실제 서비스로 키우면 SQLite/PostgreSQL로 바꾸는 걸 추천하지만,
// 처음 테스트/개인용으로는 이 정도로 충분해요.
const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "data.json");

function load() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = { links: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

module.exports = { load, save };
