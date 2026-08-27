using System.Windows;
using System.Windows.Controls;

namespace ActMon.Setup.Mvvm;

/// <summary>
/// PasswordBox.Password is deliberately not a DependencyProperty (so it never
/// ends up in a binding trace or view snapshot) — this attached property is the
/// standard WPF workaround, letting every masked-credential field in the wizard
/// (Postgres/Redis/ClickHouse/Super Admin) bind like any other field while the
/// UI itself still renders masked.
/// </summary>
public static class PasswordBoxBehavior
{
    // BindsTwoWayByDefault matters here: a Binding markup extension without an
    // explicit Mode= only defaults to TwoWay when the TARGET property's own
    // metadata asks for it. Every BoundPassword usage in the wizard XAML omits
    // Mode=TwoWay, so with plain PropertyMetadata those bindings were silently
    // OneWay — a typed password reached the PasswordBox's own display (and this
    // attached property locally) but never flowed back out to the view model.
    public static readonly DependencyProperty BoundPassword = DependencyProperty.RegisterAttached(
        "BoundPassword", typeof(string), typeof(PasswordBoxBehavior),
        new FrameworkPropertyMetadata(string.Empty, FrameworkPropertyMetadataOptions.BindsTwoWayByDefault, OnBoundPasswordChanged));

    /// <summary>
    /// A separate "enable binding" switch — required because WPF never invokes
    /// a DependencyProperty's changed callback when the new effective value
    /// equals the current one, and every password field here starts bound to
    /// an empty view-model string, which already equals BoundPassword's own
    /// default (""). That silent no-op meant OnBoundPasswordChanged never ran
    /// on page load, so the PasswordChanged handler below was never actually
    /// subscribed — nothing typed into the box ever reached the view model,
    /// confirmed directly (PostgreSQL's Test Connection kept failing with
    /// Npgsql's "no password provided" error despite typing one in). This
    /// property's own default is false, so setting it to true in XAML is
    /// always a genuine transition and reliably fires exactly once per box,
    /// regardless of what BoundPassword's bound value happens to start as.
    /// </summary>
    public static readonly DependencyProperty BindPassword = DependencyProperty.RegisterAttached(
        "BindPassword", typeof(bool), typeof(PasswordBoxBehavior),
        new PropertyMetadata(false, OnBindPasswordChanged));

    private static readonly DependencyProperty UpdatingProperty = DependencyProperty.RegisterAttached(
        "Updating", typeof(bool), typeof(PasswordBoxBehavior), new PropertyMetadata(false));

    public static string GetBoundPassword(DependencyObject dp) => (string)dp.GetValue(BoundPassword);
    public static void SetBoundPassword(DependencyObject dp, string value) => dp.SetValue(BoundPassword, value);

    public static bool GetBindPassword(DependencyObject dp) => (bool)dp.GetValue(BindPassword);
    public static void SetBindPassword(DependencyObject dp, bool value) => dp.SetValue(BindPassword, value);

    private static void OnBoundPasswordChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        if (d is not PasswordBox box) return;
        if (!(bool)box.GetValue(UpdatingProperty))
            box.Password = (string?)e.NewValue ?? "";
    }

    private static void OnBindPasswordChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        if (d is not PasswordBox box) return;

        if ((bool)e.OldValue)
            box.PasswordChanged -= HandlePasswordChanged;
        if ((bool)e.NewValue)
            box.PasswordChanged += HandlePasswordChanged;
    }

    private static void HandlePasswordChanged(object sender, RoutedEventArgs e)
    {
        var box = (PasswordBox)sender;
        box.SetValue(UpdatingProperty, true);
        SetBoundPassword(box, box.Password);
        box.SetValue(UpdatingProperty, false);
    }
}
