"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionLevel = void 0;
var PermissionLevel;
(function (PermissionLevel) {
    PermissionLevel[PermissionLevel["SUPER_ADMIN"] = 4] = "SUPER_ADMIN";
    PermissionLevel[PermissionLevel["ADMIN"] = 3] = "ADMIN";
    PermissionLevel[PermissionLevel["ANALYST"] = 2] = "ANALYST";
    PermissionLevel[PermissionLevel["VIEWER"] = 1] = "VIEWER";
    PermissionLevel[PermissionLevel["NONE"] = 0] = "NONE";
})(PermissionLevel || (exports.PermissionLevel = PermissionLevel = {}));
