"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BoardsAPI = exports.version = exports.CardsAPI = exports.FavroHttpClient = void 0;
var http_client_1 = require("./lib/http-client");
Object.defineProperty(exports, "FavroHttpClient", { enumerable: true, get: function () { return http_client_1.FavroHttpClient; } });
var cards_api_1 = require("./lib/cards-api");
Object.defineProperty(exports, "CardsAPI", { enumerable: true, get: function () { return cards_api_1.CardsAPI; } });
exports.version = '0.1.0';
var boards_api_1 = require("./lib/boards-api");
Object.defineProperty(exports, "BoardsAPI", { enumerable: true, get: function () { return boards_api_1.BoardsAPI; } });
//# sourceMappingURL=index.js.map