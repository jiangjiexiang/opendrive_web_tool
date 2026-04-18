#include "OpenDriveMap.h"
#include "Road.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

struct Pt2
{
    double x = 0.0;
    double y = 0.0;
};

struct SamplePt
{
    double x = 0.0;
    double y = 0.0;
    double s = 0.0;
    double hdg = 0.0;
};

static std::string json_escape(const std::string& input)
{
    std::ostringstream out;
    for (char ch : input)
    {
        switch (ch)
        {
            case '\"':
                out << "\\\"";
                break;
            case '\\':
                out << "\\\\";
                break;
            case '\b':
                out << "\\b";
                break;
            case '\f':
                out << "\\f";
                break;
            case '\n':
                out << "\\n";
                break;
            case '\r':
                out << "\\r";
                break;
            case '\t':
                out << "\\t";
                break;
            default:
                if (static_cast<unsigned char>(ch) < 0x20)
                    out << "\\u" << std::hex << static_cast<int>(ch);
                else
                    out << ch;
                break;
        }
    }
    return out.str();
}

static bool nearly_same(const Pt2& a, const Pt2& b)
{
    return std::fabs(a.x - b.x) < 1e-6 && std::fabs(a.y - b.y) < 1e-6;
}

static void append_line(std::vector<Pt2>& dst, const odr::Line3D& src)
{
    for (const auto& p : src)
    {
        Pt2 pt{p[0], p[1]};
        if (!dst.empty() && nearly_same(dst.back(), pt))
            continue;
        dst.push_back(pt);
    }
}

static void append_samples(std::vector<SamplePt>& dst, const std::vector<SamplePt>& src)
{
    for (const auto& p : src)
    {
        if (!dst.empty())
        {
            const Pt2 a{dst.back().x, dst.back().y};
            const Pt2 b{p.x, p.y};
            if (nearly_same(a, b))
                continue;
        }
        dst.push_back(p);
    }
}

static std::string road_link_type_to_str(odr::RoadLink::Type type)
{
    switch (type)
    {
        case odr::RoadLink::Type::Road:
            return "road";
        case odr::RoadLink::Type::Junction:
            return "junction";
        default:
            return "none";
    }
}

static std::vector<SamplePt> sample_refline(const odr::Road& road, double s0, double s1, double eps)
{
    std::vector<SamplePt> out;
    const std::set<double> s_vals = road.ref_line.approximate_linear(eps, s0, s1);
    for (const double s : s_vals)
    {
        const odr::Vec3D p = road.ref_line.get_xyz(s);
        const odr::Vec3D d = road.ref_line.derivative(s);
        out.push_back({p[0], p[1], s, std::atan2(d[1], d[0])});
    }
    return out;
}

int main(int argc, char** argv)
{
    if (argc < 2)
    {
        std::cerr << "usage: odr_json_parser <xodr_file> [eps]" << std::endl;
        return 2;
    }

    const std::string xodr_file = argv[1];
    double eps = 0.2;
    if (argc >= 3)
        eps = std::max(0.01, std::atof(argv[2]));

    try
    {
        odr::OpenDriveMap odr_map(xodr_file);
        const std::vector<odr::Road> roads = odr_map.get_roads();

        std::ostringstream out;
        out.setf(std::ios::fixed);
        out.precision(9);
        out << "{\"roads\":[";

        for (size_t ri = 0; ri < roads.size(); ++ri)
        {
            const odr::Road& road = roads[ri];
            const std::vector<odr::LaneSection> sections = road.get_lanesections();

            std::vector<SamplePt> ref_points;
            std::vector<Pt2> left_boundary;
            std::vector<Pt2> right_boundary;
            std::map<int, std::vector<Pt2>> lane_boundaries;

            int left_lane_count = 0;
            int right_lane_count = 0;
            std::string center_type = "none";
            double lane_width = 3.5;

            for (size_t si = 0; si < sections.size(); ++si)
            {
                const odr::LaneSection& sec = sections[si];
                const double s_start = sec.s0;
                const double s_end = road.get_lanesection_end(sec);

                append_samples(ref_points, sample_refline(road, s_start, s_end, eps));

                const std::vector<odr::Lane> lanes = sec.get_lanes();
                int left_outer_id = 0;
                int right_outer_id = 0;
                bool has_left_outer = false;
                bool has_right_outer = false;

                for (const auto& lane : lanes)
                {
                    if (lane.id > 0)
                    {
                        left_lane_count = std::max(left_lane_count, lane.id);
                        if (!has_left_outer || lane.id > left_outer_id)
                        {
                            has_left_outer = true;
                            left_outer_id = lane.id;
                        }
                    }
                    else if (lane.id < 0)
                    {
                        right_lane_count = std::max(right_lane_count, -lane.id);
                        if (!has_right_outer || lane.id < right_outer_id)
                        {
                            has_right_outer = true;
                            right_outer_id = lane.id;
                        }
                    }
                    else
                    {
                        center_type = lane.type;
                    }

                    if (lane.id != 0)
                    {
                        if (std::fabs(lane_width - 3.5) < 1e-6)
                        {
                            const double w = std::fabs(lane.lane_width.evaluate(s_start));
                            if (w > 1e-6)
                                lane_width = w;
                        }
                        append_line(lane_boundaries[lane.id], road.get_lane_border_line(lane, s_start, s_end, eps, true));
                    }
                }

                if (has_left_outer)
                {
                    append_line(left_boundary, road.get_lane_border_line(sec.get_lane(left_outer_id), s_start, s_end, eps, true));
                }
                if (has_right_outer)
                {
                    append_line(right_boundary, road.get_lane_border_line(sec.get_lane(right_outer_id), s_start, s_end, eps, true));
                }
            }

            out << "{";
            out << "\"id\":\"" << json_escape(road.id) << "\",";
            out << "\"junction\":\"" << json_escape(road.junction) << "\",";
            out << "\"length\":" << road.length << ",";
            out << "\"leftLaneCount\":" << left_lane_count << ",";
            out << "\"rightLaneCount\":" << right_lane_count << ",";
            out << "\"centerType\":\"" << json_escape(center_type) << "\",";
            out << "\"laneWidth\":" << lane_width << ",";
            out << "\"predecessorType\":\"" << road_link_type_to_str(road.predecessor.type) << "\",";
            out << "\"predecessorId\":\"" << json_escape(road.predecessor.id) << "\",";
            out << "\"successorType\":\"" << road_link_type_to_str(road.successor.type) << "\",";
            out << "\"successorId\":\"" << json_escape(road.successor.id) << "\",";

            out << "\"points\":[";
            for (size_t i = 0; i < ref_points.size(); ++i)
            {
                const auto& p = ref_points[i];
                out << "{\"x\":" << p.x << ",\"y\":" << p.y << ",\"s\":" << p.s << ",\"hdg\":" << p.hdg << "}";
                if (i + 1 < ref_points.size())
                    out << ",";
            }
            out << "],";

            out << "\"nativeLeftBoundary\":[";
            for (size_t i = 0; i < left_boundary.size(); ++i)
            {
                out << "{\"x\":" << left_boundary[i].x << ",\"y\":" << left_boundary[i].y << "}";
                if (i + 1 < left_boundary.size())
                    out << ",";
            }
            out << "],";

            out << "\"nativeRightBoundary\":[";
            for (size_t i = 0; i < right_boundary.size(); ++i)
            {
                out << "{\"x\":" << right_boundary[i].x << ",\"y\":" << right_boundary[i].y << "}";
                if (i + 1 < right_boundary.size())
                    out << ",";
            }
            out << "],";

            out << "\"nativeLaneBoundaries\":[";
            bool first_lane = true;
            for (const auto& it : lane_boundaries)
            {
                if (!first_lane)
                    out << ",";
                first_lane = false;
                out << "{\"laneId\":" << it.first << ",\"points\":[";
                for (size_t i = 0; i < it.second.size(); ++i)
                {
                    out << "{\"x\":" << it.second[i].x << ",\"y\":" << it.second[i].y << "}";
                    if (i + 1 < it.second.size())
                        out << ",";
                }
                out << "]}";
            }
            out << "]";

            out << "}";
            if (ri + 1 < roads.size())
                out << ",";
        }

        out << "]}";
        std::cout << out.str();
        return 0;
    }
    catch (const std::exception& e)
    {
        std::cerr << e.what() << std::endl;
        return 1;
    }
}
