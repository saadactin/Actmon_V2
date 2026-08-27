using System.Security.Cryptography;

namespace ActMon.Setup.Core.Services;

public static class SecretGenerator
{
    /// <summary>Matches the app's own JWT_SECRET convention (a long hex string).</summary>
    public static string GenerateHex(int byteLength = 32) => Convert.ToHexString(RandomNumberGenerator.GetBytes(byteLength)).ToLowerInvariant();

    /// <summary>
    /// Matches ACTMON_ENCRYPTION_KEY's documented format exactly (.env.example):
    /// base64 of 32 random bytes, generated the same way as
    /// `python -c "import base64, os; print(base64.b64encode(os.urandom(32)).decode())"`.
    /// </summary>
    public static string GenerateBase64Key(int byteLength = 32) => Convert.ToBase64String(RandomNumberGenerator.GetBytes(byteLength));
}
