using System.Globalization;
using System.Windows;
using System.Windows.Data;
using System.Windows.Media;

namespace ActMon.Setup.Converters;

public sealed class BoolToVisConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is true ? Visibility.Visible : Visibility.Collapsed;

    public object ConvertBack(object value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}

public sealed class InverseBoolToVisConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is true ? Visibility.Collapsed : Visibility.Visible;

    public object ConvertBack(object value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}

/// <summary>Two-way bool inverter — used to bind two mutually-exclusive
/// RadioButtons' IsChecked to the same underlying bool from opposite sides.</summary>
public sealed class InverseBoolConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is bool b ? !b : Binding.DoNothing;

    public object ConvertBack(object value, Type targetType, object? parameter, CultureInfo culture) =>
        value is bool b ? !b : Binding.DoNothing;
}

public sealed class NullToVisConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is null or "" ? Visibility.Collapsed : Visibility.Visible;

    public object ConvertBack(object value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}

public sealed class NullableBoolToBrushConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) => value switch
    {
        true => Application.Current.TryFindResource("SuccessBrush") as Brush ?? Brushes.Green,
        false => Application.Current.TryFindResource("DangerBrush") as Brush ?? Brushes.Red,
        _ => Application.Current.TryFindResource("MutedBrush") as Brush ?? Brushes.Gray,
    };

    public object ConvertBack(object value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}

/// <summary>Looks a named brush up from the app's resource dictionary — lets a view
/// model expose a plain string key (e.g. "SuccessBrush") instead of depending on
/// System.Windows.Media types.</summary>
public sealed class BrushKeyConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        if (value is string key && Application.Current.TryFindResource(key) is Brush brush)
            return brush;
        return Brushes.Black;
    }

    public object ConvertBack(object value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}
